#include "report/LockReporter.h"

#include <QJsonArray>
#include <QJsonObject>
#include <QTimer>
#include <cstdio>
#include <memory>
#include <utility>

#include "control/ControlClient.h"

using namespace Qt::StringLiterals;

LockReporter::LockReporter(ControlClient* client, QObject* parent)
    : QObject(parent)
    , m_client(client)
{
    connect(client, &ControlClient::opened, this, [this] {
        if (m_known)
            send();
    });
}

void LockReporter::setLocked(bool locked)
{
    m_locked = locked;
    m_known = true;
    send();
}

void LockReporter::reportUnlocked(std::function<void()> then, int timeoutMs)
{
    m_locked = false;
    m_known = true;
    auto pending = std::make_shared<std::function<void()>>(std::move(then));
    const auto finish = [pending] {
        if (auto callback = std::exchange(*pending, {}))
            callback();
    };
    QTimer::singleShot(timeoutMs, this, finish);
    send(finish);
}

void LockReporter::send(std::function<void()> done)
{
    m_client->invoke(u"sys:setLocked"_s, QJsonArray{QJsonObject{{"locked", m_locked}}},
                     [done = std::move(done)](const ControlResult& r) {
                         if (!r.ok && r.code != u"closed")
                             std::fprintf(stderr, "jarvis-lock: jarvisd refused sys:setLocked (%s): %s\n",
                                          qPrintable(r.code), qPrintable(r.text));
                         if (done)
                             done();
                     });
}
