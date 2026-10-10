#include <QSet>
#include <QSignalSpy>
#include <QtTest>

#include "Language.h"
#include "models/CuSettingsModel.h"

using namespace Qt::StringLiterals;

namespace {
QJsonObject provider(const QString& id, const QString& kind, const QString& url, const QString& model, const QJsonValue& vision)
{
    QJsonObject o{{"id", id}, {"kind", kind}, {"baseUrl", url}, {"model", model}, {"hasKey", false}};
    if (!vision.isUndefined())
        o.insert("vision", vision);
    return o;
}

// Contracts §4.8: each entry carries computerUse {enabled, consentAt}.
QJsonObject withCu(QJsonObject entry, bool enabled, const QJsonValue& consentAt)
{
    entry.insert("computerUse", QJsonObject{{"enabled", enabled}, {"consentAt", consentAt}});
    return entry;
}

QJsonObject list(const QSet<QString>& enabled = {}, const QSet<QString>& consented = {})
{
    QJsonArray providers{
                         provider(u"local"_s, u"ollama"_s, u"http://localhost:11434"_s, u"qwen2.5vl:7b"_s, true),
                         provider(u"work"_s, u"anthropic"_s, u"https://api.anthropic.com"_s, u"claude-sonnet-5-5"_s, true),
                         provider(u"tiny"_s, u"ollama"_s, u"http://127.0.0.1:11434"_s, u"qwen3:1.7b"_s, false),
                         provider(u"den"_s, u"ollama"_s, u"http://192.168.1.20:11434"_s, u"llava:13b"_s, true),
                         provider(u"vps"_s, u"ollama"_s, u"https://ollama.example.com"_s, u"llava:13b"_s, true),
                         provider(u"vpsip"_s, u"ollama"_s, u"http://203.0.113.7:11434"_s, u"llava:13b"_s, true),
                         provider(u"llama"_s, u"openai-compatible"_s, u"http://[::1]:8080/v1"_s, u"vl"_s, true),
                         provider(u"old"_s, u"anthropic"_s, u"https://api.anthropic.com"_s, u"claude-x"_s, QJsonValue::Undefined)};
    for (qsizetype i = 0; i < providers.size(); ++i) {
        const QJsonObject o = providers.at(i).toObject();
        const QString id = o.value("id").toString();
        providers[i] = withCu(o, enabled.contains(id),
                              consented.contains(id) ? QJsonValue(u"2026-10-10T10:00:00Z"_s) : QJsonValue(QJsonValue::Null));
    }
    return QJsonObject{{"providers", providers}, {"activeId", "local"}};
}

int rowOf(const CuSettingsModel& m, const QString& id)
{
    for (int i = 0; i < m.rowCount(); ++i)
        if (m.data(m.index(i), CuSettingsModel::IdRole).toString() == id)
            return i;
    return -1;
}

QVariant role(const CuSettingsModel& m, const QString& id, int r)
{
    return m.data(m.index(rowOf(m, id)), r);
}
} // namespace

class TestCuSettings : public QObject {
    Q_OBJECT
private slots:
    void offByDefaultAndVisionFromTheList()
    {
        CuSettingsModel m;
        QVERIFY(!m.known());
        m.loadList(list());
        QVERIFY(m.known());
        QCOMPARE(m.count(), 8);
        for (int i = 0; i < m.rowCount(); ++i)
            QVERIFY(!m.data(m.index(i), CuSettingsModel::EnabledRole).toBool());
        QVERIFY(role(m, u"local"_s, CuSettingsModel::VisionRole).toBool());
        QVERIFY(!role(m, u"tiny"_s, CuSettingsModel::VisionRole).toBool());
        QVERIFY(!role(m, u"old"_s, CuSettingsModel::VisionRole).toBool()); // missing vision = no vision
        QCOMPARE(role(m, u"work"_s, CuSettingsModel::NameRole).toString(), u"claude-sonnet-5-5 · Anthropic"_s);
        QCOMPARE(role(m, u"tiny"_s, CuSettingsModel::ReasonRole).toString(),
                 u"This model can't see images, so it can't use the screen."_s);
        QCOMPARE(role(m, u"local"_s, CuSettingsModel::ReasonRole).toString(), QString());
    }

    void storedConfigIsShown()
    {
        CuSettingsModel m;
        m.loadList(list({u"local"_s, u"tiny"_s}, {u"work"_s}));
        QVERIFY(role(m, u"local"_s, CuSettingsModel::EnabledRole).toBool());
        QVERIFY(!role(m, u"tiny"_s, CuSettingsModel::EnabledRole).toBool()); // enabled without vision shows off
        QVERIFY(role(m, u"work"_s, CuSettingsModel::ConsentedRole).toBool());
        QVERIFY(!role(m, u"den"_s, CuSettingsModel::ConsentedRole).toBool());
    }

    void privacyFollowsTheEndpoint()
    {
        CuSettingsModel m;
        m.loadList(list());
        QVERIFY(!role(m, u"local"_s, CuSettingsModel::NeedsConsentRole).toBool());
        QVERIFY(!role(m, u"llama"_s, CuSettingsModel::NeedsConsentRole).toBool()); // [::1] is this computer
        QVERIFY(role(m, u"work"_s, CuSettingsModel::NeedsConsentRole).toBool());
        QVERIFY(role(m, u"den"_s, CuSettingsModel::NeedsConsentRole).toBool()); // LAN: screenshots leave the machine
        QCOMPARE(role(m, u"local"_s, CuSettingsModel::PrivacyRole).toString(), u"Screenshots stay on this computer."_s);
        QCOMPARE(role(m, u"llama"_s, CuSettingsModel::PrivacyRole).toString(), u"Screenshots stay on this computer."_s);
        QCOMPARE(role(m, u"work"_s, CuSettingsModel::PrivacyRole).toString(),
                 u"Screenshots of the allowed windows go to Anthropic."_s);
        QCOMPARE(role(m, u"den"_s, CuSettingsModel::PrivacyRole).toString(),
                 u"Screenshots of the allowed windows go to a computer on your network."_s);
        // A public Ollama host is not "your network": name the host.
        QCOMPARE(role(m, u"vps"_s, CuSettingsModel::PrivacyRole).toString(),
                 u"Screenshots of the allowed windows go to ollama.example.com."_s);
        QCOMPARE(role(m, u"vpsip"_s, CuSettingsModel::PrivacyRole).toString(),
                 u"Screenshots of the allowed windows go to 203.0.113.7."_s);
    }

    void noVisionCannotBeEnabled()
    {
        CuSettingsModel m;
        m.loadList(list());
        QSignalSpy enables(&m, &CuSettingsModel::setEnabledRequested);
        m.setEnabled(rowOf(m, u"tiny"_s), true);
        m.setEnabled(rowOf(m, u"old"_s), true);
        m.setEnabled(-1, true);
        m.setEnabled(99, true);
        QCOMPARE(enables.size(), 0);
        QCOMPARE(m.consentProviderId(), QString());
    }

    void localEnablesWithoutConsent()
    {
        CuSettingsModel m;
        m.loadList(list());
        QSignalSpy enables(&m, &CuSettingsModel::setEnabledRequested);
        QSignalSpy consents(&m, &CuSettingsModel::consentRequested);
        m.setEnabled(rowOf(m, u"local"_s), true);
        QCOMPARE(enables.size(), 1);
        QCOMPARE(enables[0][0].toString(), u"local"_s);
        QCOMPARE(enables[0][1].toBool(), true);
        QCOMPARE(consents.size(), 0);
        QVERIFY(m.busy());
        m.setEnabled(rowOf(m, u"llama"_s), true); // busy: ignored
        QCOMPARE(enables.size(), 1);
        m.applyEnabledResult(u"local"_s, true, true, {}, {});
        QVERIFY(!m.busy());
        QVERIFY(role(m, u"local"_s, CuSettingsModel::EnabledRole).toBool());
    }

    void cloudNeedsConsentOnce()
    {
        CuSettingsModel m;
        m.loadList(list());
        QSignalSpy enables(&m, &CuSettingsModel::setEnabledRequested);
        QSignalSpy consents(&m, &CuSettingsModel::consentRequested);
        const int work = rowOf(m, u"work"_s);
        m.setEnabled(work, true);
        QCOMPARE(enables.size(), 0);
        QCOMPARE(m.consentProviderId(), u"work"_s);
        QCOMPARE(m.consentProviderName(), u"Anthropic"_s);
        m.acceptConsent();
        QCOMPARE(consents.size(), 1);
        QCOMPARE(consents[0][0].toString(), u"work"_s);
        QCOMPARE(enables.size(), 0); // not before jarvisd recorded the consent
        m.applyConsentResult(u"work"_s, true, {}, {});
        QCOMPARE(m.consentProviderId(), QString());
        QCOMPARE(enables.size(), 1);
        QCOMPARE(enables[0][0].toString(), u"work"_s);
        m.applyEnabledResult(u"work"_s, true, true, {}, {});
        QVERIFY(role(m, u"work"_s, CuSettingsModel::EnabledRole).toBool());

        m.setEnabled(work, false); // switching off never asks
        QCOMPARE(enables.size(), 2);
        QCOMPARE(enables[1][1].toBool(), false);
        m.applyEnabledResult(u"work"_s, false, true, {}, {});
        m.setEnabled(work, true); // consent already given
        QCOMPARE(enables.size(), 3);
        QCOMPARE(consents.size(), 1);
    }

    void storedConsentSkipsTheDialog()
    {
        CuSettingsModel m;
        m.loadList(list({}, {u"work"_s}));
        QSignalSpy enables(&m, &CuSettingsModel::setEnabledRequested);
        m.setEnabled(rowOf(m, u"work"_s), true);
        QCOMPARE(enables.size(), 1);
        QCOMPARE(m.consentProviderId(), QString());
    }

    void lanProviderAsksForConsent()
    {
        CuSettingsModel m;
        m.loadList(list());
        m.setEnabled(rowOf(m, u"den"_s), true);
        QCOMPARE(m.consentProviderId(), u"den"_s);
        QCOMPARE(m.consentProviderName(), u"a computer on your network"_s);
    }

    void declineSendsNothing()
    {
        CuSettingsModel m;
        m.loadList(list());
        QSignalSpy enables(&m, &CuSettingsModel::setEnabledRequested);
        QSignalSpy consents(&m, &CuSettingsModel::consentRequested);
        m.setEnabled(rowOf(m, u"work"_s), true);
        m.declineConsent();
        QCOMPARE(m.consentProviderId(), QString());
        m.acceptConsent(); // nothing pending any more
        QCOMPARE(consents.size(), 0);
        QCOMPARE(enables.size(), 0);
        QVERIFY(!role(m, u"work"_s, CuSettingsModel::EnabledRole).toBool());
    }

    void declineIsIgnoredWhileConsentInFlight()
    {
        CuSettingsModel m;
        m.loadList(list());
        QSignalSpy enables(&m, &CuSettingsModel::setEnabledRequested);
        m.setEnabled(rowOf(m, u"work"_s), true);
        m.acceptConsent();
        m.declineConsent(); // too late: the request is already out
        QCOMPARE(m.consentProviderId(), u"work"_s);
        m.applyConsentResult(u"work"_s, true, QString(), QString());
        QCOMPARE(enables.size(), 1);
    }

    void consentFailureEnablesNothing()
    {
        CuSettingsModel m;
        m.loadList(list());
        QSignalSpy enables(&m, &CuSettingsModel::setEnabledRequested);
        m.setEnabled(rowOf(m, u"work"_s), true);
        m.acceptConsent();
        m.applyConsentResult(u"work"_s, false, u"internal"_s, u"disk full"_s);
        QCOMPARE(enables.size(), 0);
        QVERIFY(!m.busy());
        QCOMPARE(m.consentProviderId(), QString());
        QCOMPARE(m.note(), u"Couldn't change computer use: disk full"_s);
        QVERIFY(!role(m, u"work"_s, CuSettingsModel::ConsentedRole).toBool());
    }

    void reloadDropsTheDialogForARemovedProvider()
    {
        CuSettingsModel m;
        m.loadList(list());
        m.setEnabled(rowOf(m, u"work"_s), true);
        QJsonObject without = list();
        QJsonArray providers;
        for (const QJsonValue& p : without.value("providers").toArray())
            if (p.toObject().value("id").toString() != u"work")
                providers.append(p);
        without["providers"] = providers;
        m.loadList(without);
        QCOMPARE(m.consentProviderId(), QString());
    }

    void enableErrors()
    {
        CuSettingsModel m;
        m.loadList(list());
        m.setEnabled(rowOf(m, u"local"_s), true);
        m.applyEnabledResult(u"local"_s, true, false, u"unsupported"_s, u"unknown channel"_s);
        QCOMPARE(m.note(), u"This version of Jarvis can't use the screen yet."_s);
        QVERIFY(!role(m, u"local"_s, CuSettingsModel::EnabledRole).toBool());
        m.setEnabled(rowOf(m, u"local"_s), true);
        QCOMPARE(m.note(), QString()); // a new attempt clears the old note
        m.applyEnabledResult(u"local"_s, true, false, u"invalid"_s, u"provider has no vision"_s);
        QCOMPARE(m.note(), u"Couldn't change computer use: provider has no vision"_s);
    }

    void excludedAppsAreFixed()
    {
        CuSettingsModel m;
        QCOMPARE(m.excludedApps(), (QStringList{u"Jarvis apps, the shell and Settings"_s, u"Lock screen"_s, u"Installer"_s,
                                                u"Password and key prompts (polkit, keyrings, SSH)"_s, u"Terminals"_s,
                                                u"Password fields in any app"_s}));
    }

    void arabicTexts()
    {
        qputenv("JARVIS_I18N_DIR", JARVIS_TEST_I18N_DIR);
        jarvis::ui::LanguageManager language({u"jarvis-ui"_s, u"jarvis-shell"_s});
        QVERIFY(language.setLanguage(u"ar"_s));
        CuSettingsModel m;
        m.loadList(list());
        QCOMPARE(m.excludedApps().at(1), u"شاشة القفل"_s);
        QCOMPARE(role(m, u"local"_s, CuSettingsModel::PrivacyRole).toString(), u"تبقى لقطات الشاشة على هذا الحاسوب."_s);
        QCOMPARE(role(m, u"work"_s, CuSettingsModel::PrivacyRole).toString(),
                 u"تُرسَل لقطات النوافذ المسموح بها إلى Anthropic."_s);
        QVERIFY(language.setLanguage(u"en"_s));
    }
};

QTEST_GUILESS_MAIN(TestCuSettings)
#include "tst_cusettings.moc"
