#include "model/LockModel.h"

#include <algorithm>

using namespace Qt::StringLiterals;

LockModel::LockModel(Authenticator* authenticator, CurrentUser user, QObject* parent)
    : QObject(parent)
    , m_authenticator(authenticator)
    , m_user(std::move(user))
{
    connect(authenticator, &Authenticator::finished, this, &LockModel::onFinished);
    m_timer.setInterval(1000);
    connect(&m_timer, &QTimer::timeout, this, &LockModel::tick);
}

int LockModel::cooldownFor(int failures)
{
    if (failures < 3)
        return 0;
    static constexpr int steps[] = {5, 10, 20, 30};
    return steps[std::min(failures - 3, 3)];
}

void LockModel::submit(const QString& secret)
{
    if (m_state != u"ready" || secret.isEmpty())
        return;
    QByteArray bytes = secret.toUtf8();
    m_errorText.clear();
    setState(u"checking"_s);
    m_authenticator->start(m_user.login, std::move(bytes));
}

void LockModel::onFinished(bool ok, const QString& message)
{
    if (m_state != u"checking")
        return; // nothing was asked
    if (ok) {
        setState(u"unlocking"_s);
        emit unlockRequested();
        return;
    }
    ++m_failures;
    const QString why = message.trimmed().left(160);
    m_errorText = why.isEmpty() ? u"That password didn't work. Try again."_s
                                : u"That password didn't work: %1"_s.arg(why);
    m_cooldown = cooldownFor(m_failures);
    if (m_cooldown > 0) {
        m_timer.start();
        setState(u"cooldown"_s);
    } else {
        setState(u"ready"_s);
    }
}

void LockModel::tick()
{
    if (m_state != u"cooldown")
        return;
    if (--m_cooldown > 0)
        return emit stateChanged();
    m_timer.stop();
    setState(u"ready"_s);
}

void LockModel::setState(const QString& state)
{
    m_state = state;
    emit stateChanged();
}
