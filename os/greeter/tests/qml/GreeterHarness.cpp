#include "GreeterHarness.h"

#include <QFile>

#include "FakeGreetd.h"
#include "FakePower.h"
#include "GreetdClient.h"
#include "LoginModel.h"
#include "ModelStatus.h"

using namespace Qt::StringLiterals;

GreeterHarness::GreeterHarness(QObject* parent)
    : QObject(parent)
{
}

GreeterHarness::~GreeterHarness()
{
    delete m_greetd;
}

LoginModel* GreeterHarness::fresh(const QVariantMap& options)
{
    for (QObject* old : {static_cast<QObject*>(m_login), static_cast<QObject*>(m_client), static_cast<QObject*>(m_power)})
        if (old)
            old->deleteLater();
    delete m_greetd;
    m_greetd = new FakeGreetd;
    m_greetd->extraPrompt = options.value(u"extraPrompt"_s).toString();
    m_greetd->extraAnswer = u"123456"_s;
    m_greetd->startError = options.value(u"startError"_s).toString();
    if (!m_greetd->listen())
        qFatal("fake greetd cannot listen");
    m_power = new FakePower(this);
    m_client = new GreetdClient(m_greetd->socketPath(), this);
    QList<UserEntry> users;
    if (options.value(u"users"_s, true).toBool())
        users = {{u"mohamed"_s, u"Mohamed Abdelhay"_s, 1000}};
    m_login = new LoginModel(m_client, m_power, users, this);
    return m_login;
}

ModelStatus* GreeterHarness::status(const QString& stateJson)
{
    if (m_status)
        m_status->deleteLater();
    const QString path = m_dir.filePath(u"model-state.json"_s);
    QFile::remove(path);
    if (!stateJson.isEmpty()) {
        QFile file(path);
        if (file.open(QIODevice::WriteOnly))
            file.write(stateJson.toUtf8());
    }
    m_status = new ModelStatus(path, QStringLiteral(JARVIS_GREETER_TEST_DATA "/catalog.json"), this);
    return m_status;
}

QStringList GreeterHarness::requestTypes() const
{
    QStringList out;
    if (m_greetd)
        for (const QJsonObject& r : m_greetd->received)
            out << r.value("type").toString();
    return out;
}

QStringList GreeterHarness::powerCalls() const { return m_power ? m_power->calls : QStringList{}; }
void GreeterHarness::dropNextCreate() { m_greetd->dropOnCreate = true; }
