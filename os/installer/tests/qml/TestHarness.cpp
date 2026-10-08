#include "TestHarness.h"

#include <QJsonArray>

#include "FakeInstallerBackend.h"
#include "FakePower.h"
#include "Fixtures.h"
#include "InstallerModel.h"

using namespace Qt::StringLiterals;

TestHarness::TestHarness(QObject* parent)
    : QObject(parent)
{
}

InstallerModel* TestHarness::fresh(const QVariantMap& options)
{
    for (QObject* old : {static_cast<QObject*>(m_model), static_cast<QObject*>(m_backend), static_cast<QObject*>(m_power)})
        if (old)
            old->deleteLater();
    m_backend = new FakeInstallerBackend(this);
    m_power = new FakePower(this);
    QJsonObject probe = loadFixture(u"probe-windows.json"_s);
    if (options.contains(u"uefi"_s))
        probe.insert("uefi", options.value(u"uefi"_s).toBool());
    if (const QString flag = options.value(u"windows"_s).toString(); !flag.isEmpty()) {
        QJsonArray disks = probe.value("disks").toArray();
        QJsonObject disk = disks.at(0).toObject();
        QJsonArray parts = disk.value("partitions").toArray();
        QJsonObject windows = parts.at(1).toObject();
        QJsonObject ntfs = windows.value("ntfs").toObject();
        ntfs.insert(flag, true);
        windows.insert("ntfs", ntfs);
        parts.replace(1, windows);
        disk.insert("partitions", parts);
        disks.replace(0, disk);
        probe.insert("disks", disks);
    }
    m_backend->probeResult = probe;
    m_backend->planTemplate = loadFixture(u"plan-alongside.json"_s);
    if (options.value(u"failProbe"_s).toBool())
        m_backend->failNext = u"Probe"_s;
    m_model = new InstallerModel(m_backend, m_power, u"Rafiq"_s, u"en_US"_s, "Africa/Cairo", this);
    if (m_language)
        m_model->setLanguageApplier([language = m_language](const QString& code) { return language->setLanguage(code); });
    m_model->start();
    return m_model;
}

QStringList TestHarness::calls() const { return m_backend ? m_backend->calls : QStringList{}; }
QVariantMap TestHarness::lastChoices() const
{
    return m_backend && !m_backend->choices.isEmpty() ? m_backend->choices.last().toVariantMap() : QVariantMap{};
}
QStringList TestHarness::executedPlanIds() const { return m_backend ? m_backend->executedPlanIds : QStringList{}; }
QStringList TestHarness::powerCalls() const { return m_power ? m_power->calls : QStringList{}; }

void TestHarness::refuseNext(const QString& key, const QString& message)
{
    m_backend->refuseKey = key;
    m_backend->refuseMessage = message;
}

void TestHarness::setSummary(const QStringList& lines)
{
    m_backend->planTemplate.insert("summary", QJsonArray::fromStringList(lines));
}

void TestHarness::progress(const QString& stepId, int percent, const QString& detail) { emit m_backend->progress(stepId, percent, detail); }
void TestHarness::modelProgress(int percent, const QString& detail) { emit m_backend->modelProgress(percent, detail); }
void TestHarness::finish(bool ok, const QString& errorStep, const QString& message) { emit m_backend->finished(ok, errorStep, message); }
