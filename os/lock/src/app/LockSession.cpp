#include "app/LockSession.h"

#include "app/LockBackend.h"
#include "model/LockModel.h"
#include "report/LockReporter.h"

using namespace Qt::StringLiterals;

LockSession::LockSession(LockBackend* backend, LockReporter* reporter, LockModel* model, Say say, QObject* parent)
    : QObject(parent)
    , m_backend(backend)
    , m_reporter(reporter)
    , m_model(model)
    , m_say(std::move(say))
{
    connect(backend, &LockBackend::locked, this, &LockSession::onLocked);
    connect(backend, &LockBackend::finished, this, &LockSession::onFinished);
    connect(model, &LockModel::unlockRequested, this, &LockSession::onUnlockRequested);
}

bool LockSession::start()
{
    m_reporter->setLocked(true);
    if (m_backend->lock())
        return true;
    m_say(u"refused"_s);
    m_reporter->reportUnlocked([this] { finish(Refused); });
    return false;
}

void LockSession::onLocked()
{
    if (m_locked || m_done)
        return;
    m_locked = true;
    m_say(u"locked"_s);
    if (m_unlockWanted)
        onUnlockRequested();
}

void LockSession::onFinished()
{
    if (m_done)
        return;
    if (!m_locked) {
        m_say(u"refused"_s);
        m_reporter->reportUnlocked([this] { finish(Refused); });
        return;
    }
    // The compositor dropped a lock it had granted. jarvisd keeps refusing
    // approvals; exit 1 so jarvis-idle starts a new locker.
    m_say(u"lost"_s);
    finish(LostLock);
}

void LockSession::onUnlockRequested()
{
    if (m_done)
        return;
    if (!m_locked) { // unlock_and_destroy is only valid after `locked`
        m_unlockWanted = true;
        return;
    }
    m_reporter->reportUnlocked([this] {
        if (m_done)
            return;
        m_backend->unlock();
        m_say(u"unlocked"_s);
        finish(Unlocked);
    });
}

void LockSession::finish(int code)
{
    if (m_done)
        return;
    m_done = true;
    emit exitRequested(code);
}
