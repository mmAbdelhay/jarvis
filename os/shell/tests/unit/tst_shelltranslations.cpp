#include <QtTest>

#include "Language.h"
#include "ShellFixture.h"
#include "models/AuditModel.h"
#include "models/CardModel.h"
#include "models/SystemModel.h"
#include "models/PhoneModel.h"
#include "models/voice/Recorder.h"

using namespace Qt::StringLiterals;

namespace {
QJsonArray items(int n)
{
    QJsonArray out;
    for (int i = 0; i < n; ++i)
        out.append(fixture::item(u"i%1"_s.arg(i)));
    return out;
}
} // namespace

class TestShellTranslations : public QObject {
    Q_OBJECT
    jarvis::ui::LanguageManager* m_language = nullptr;

private slots:
    void initTestCase()
    {
        qputenv("JARVIS_I18N_DIR", JARVIS_TEST_I18N_DIR);
        m_language = new jarvis::ui::LanguageManager({u"jarvis-ui"_s, u"jarvis-shell"_s}, this);
        QVERIFY(m_language->setLanguage(u"ar"_s));
    }
    void cleanupTestCase() { m_language->setLanguage(u"en"_s); }

    void generatedPromptCatalogIsArabic()
    {
        QCOMPARE(ShellController::tr("Update my computer"), u"حدّث حاسوبي"_s);
        QCOMPARE(ShellController::tr("Install the tool server %1 version %2 from the Jarvis tool registry.").arg(u"jarvis-clock"_s, u"1.0"_s),
                 u"ثبّت خادم الأدوات jarvis-clock بالإصدار 1.0 من سجل أدوات جارفيس."_s);
        QCOMPARE(ShellController::tr("Remove the installed tool server %1.").arg(u"jarvis-clock"_s), u"أزِل خادم الأدوات المثبّت jarvis-clock."_s);
    }

    void generatedPromptsUseArabic_data()
    {
        QTest::addColumn<QString>("action");
        QTest::addColumn<QString>("expected");
        QTest::newRow("updates") << u"updates"_s << u"حدّث حاسوبي"_s;
        QTest::newRow("install") << u"install"_s << u"ثبّت خادم الأدوات jarvis-clock بالإصدار 1.0 من سجل أدوات جارفيس."_s;
        QTest::newRow("remove") << u"remove"_s << u"أزِل خادم الأدوات المثبّت jarvis-clock."_s;
    }

    void generatedPromptsUseArabic()
    {
        QFETCH(QString, action);
        QFETCH(QString, expected);
        ShellFixture f;
        QVERIFY(f.open());
        if (action == u"updates")
            f.shell->askForUpdates();
        else if (action == u"install")
            emit f.shell->registry()->installRequested(u"jarvis-clock"_s, u"1.0"_s);
        else
            emit f.shell->registry()->removeRequested(u"jarvis-clock"_s);
        QTRY_COMPARE(f.requests(u"agent:prompt"_s).size(), 1);
        QCOMPARE(f.requests(u"agent:prompt"_s).first().value("a").toArray().first().toObject().value("text").toString(), expected);
    }

    void languagePushRetranslatesOpenCardAndModels()
    {
        QVERIFY(m_language->setLanguage(u"en"_s));
        ShellFixture f;
        f.shell->setLanguageApplier([this](const QString& code) { return m_language->setLanguage(code); }, u"en"_s);
        QVERIFY(f.shell->chatCard()->load(fixture::card(u"c1"_s, items(3))));
        auto* card = f.shell->chatCard();
        card->setTicked(0, false);
        QCOMPARE(card->headline(), u"Jarvis wants to do 3 things"_s);
        QCOMPARE(card->approveLabel(), u"Approve 2 of 3"_s);
        f.shell->memory()->applyItems(QJsonArray{QJsonObject{{"id", "m1"}, {"kind", "fact"}, {"text", "unchanged"}, {"createdAt", 1}}});
        f.shell->audit()->applyEntries(QJsonArray{QJsonObject{{"ts", 1}, {"title", "unchanged"}, {"decision", "approved"}, {"result", "ok"}}}, false);
        f.shell->registry()->applyList(QJsonObject{{"available", QJsonArray{QJsonObject{
            {"id", "jarvis-clock"}, {"version", "1.0"}, {"tier", "official"},
            {"name", "Clock"}, {"description", "unchanged"}, {"permissions", QJsonObject{}}, {"tools", QJsonArray{}}}}}});
        auto snapshot = fixture::snapshot(false);
        snapshot.insert("model", QJsonObject{{"model", "test"}, {"local", true}, {"supportsTools", true}});
        f.shell->system()->applySnapshot(snapshot);
        f.shell->system()->applyUpdateCounts(2, 2);
        QSignalSpy registryChanged(f.shell->registry(), &QAbstractItemModel::dataChanged);
        QSignalSpy cardChanged(card, &CardModel::changed);
        QSignalSpy systemChanged(f.shell->system(), &SystemModel::changed);
        QSignalSpy bannerChanged(f.shell.get(), &ShellController::bannerChanged);
        QSignalSpy auditChanged(f.shell->audit(), &QAbstractItemModel::dataChanged);
        QSignalSpy memoryChanged(f.shell->memory(), &QAbstractItemModel::dataChanged);
        // Deliver the control push through the real controller connection;
        // no local socket is needed for this model notification regression.
        emit f.client->push(u"ui:language"_s, QJsonObject{{"lang", "ar"}});
        QTRY_COMPARE(f.shell->language(), u"ar"_s);
        QVERIFY(!cardChanged.isEmpty());
        QVERIFY(!systemChanged.isEmpty());
        QVERIFY(!bannerChanged.isEmpty());
        QVERIFY(!auditChanged.isEmpty());
        QVERIFY(!memoryChanged.isEmpty());
        QVERIFY(!registryChanged.isEmpty());
        QCOMPARE(card->headline(), u"يريد جارفيس تنفيذ 3 إجراءات"_s);
        QCOMPARE(card->approveLabel(), u"الموافقة على 2 من 3"_s);
        QCOMPARE(f.shell->system()->memoryText(), u"0.0 / 0.0 غيغابايت"_s);
        QCOMPARE(f.shell->system()->modelDetail(), u"على أجهزتك · يستطيع التحكم في النظام"_s);
        QCOMPARE(f.shell->system()->updatesText(), u"تحديثان · تحديثان أمنيان"_s);
        QCOMPARE(f.shell->registry()->data(f.shell->registry()->index(0), RegistryModel::TierLabelRole).toString(), u"رسمي"_s);
        QCOMPARE(card->cardId(), u"c1"_s);
        QCOMPARE(card->tickedCount(), 2);
        QCOMPARE(f.shell->system()->networkDetail(), u"الاتصال: متصل"_s);
        QCOMPARE(f.shell->audit()->data(f.shell->audit()->index(0), AuditModel::DecisionLabelRole).toString(), u"تمت الموافقة"_s);
        QCOMPARE(f.shell->memory()->data(f.shell->memory()->index(0), MemoryModel::KindLabelRole).toString(), u"معلومة"_s);
    }

    void cardHeadlineUsesArabicPlurals()
    {
        CardModel two, three, eleven, hundred;
        QVERIFY(two.load(fixture::card(u"c2"_s, items(2))));
        QCOMPARE(two.headline(), u"يريد جارفيس تنفيذ إجراءين"_s);
        QVERIFY(three.load(fixture::card(u"c3"_s, items(3))));
        QCOMPARE(three.headline(), u"يريد جارفيس تنفيذ 3 إجراءات"_s);
        QVERIFY(eleven.load(fixture::card(u"c11"_s, items(11))));
        QCOMPARE(eleven.headline(), u"يريد جارفيس تنفيذ 11 إجراءً"_s);
        QCOMPARE(eleven.approveLabel(), u"الموافقة على الكل (11)"_s);
        QVERIFY(hundred.load(fixture::card(u"c100"_s, items(100))));
        QCOMPARE(hundred.headline(), u"يريد جارفيس تنفيذ 100 إجراء"_s);
    }

    void noticesAreArabic()
    {
        ShellFixture f;
        QVERIFY(f.open());
        f.pushCard(fixture::card(u"c1"_s, {fixture::item(u"a"_s)}));
        QTRY_VERIFY(f.shell->chatCard()->active());
        f.shell->decide(f.shell->chatCard(), false);
        f.push(u"agent:events"_s, QJsonObject{{"type", "card-closed"}, {"cardId", "c1"}, {"decision", "denied"}});
        QTRY_COMPARE(f.lastNotice(), u"تم الرفض. لم يتغيّر شيء."_s);
    }

    void systemTextIsArabic()
    {
        SystemModel system;
        QJsonObject snap = fixture::snapshot(false);
        snap.insert("network", QJsonObject{{"connectivity", "full"}, {"wifiSsid", "Home"}});
        system.applySnapshot(snap);
        QCOMPARE(system.networkDetail(), u"واي فاي Home · متصل"_s);
    }

    void phoneMessagesAreArabic()
    {
        PhoneModel phone;
        phone.applyOwnerPasswordResult(QJsonObject{{"ok", true}});
        QCOMPARE(phone.note(), u"تم حفظ كلمة مرور المالك."_s);
        QVERIFY(phone.error().isEmpty());
        phone.applyOwnerPasswordResult(QJsonObject{{"ok", false}, {"code", "current-wrong"}});
        QCOMPARE(phone.error(), u"كلمة مرور المالك الحالية غير صحيحة."_s);
        QVERIFY(phone.note().isEmpty());
        phone.applyOwnerPasswordResult(QJsonObject{{"ok", false}, {"code", "current-required"}});
        QCOMPARE(phone.error(), u"أدخل كلمة مرور المالك الحالية أولًا."_s);
        phone.applyOwnerPasswordResult(QJsonObject{{"ok", false}});
        QCOMPARE(phone.error(), u"تعذّر حفظ كلمة مرور المالك."_s);
        phone.applyError({});
        QCOMPARE(phone.error(), u"حدث خطأ ما. حاول مجددًا."_s);
        phone.applyError(u"Server detail"_s);
        QCOMPARE(phone.error(), u"Server detail"_s);
    }

    void recorderErrorsAreArabic()
    {
        jarvis::voice::ProcessRecorder recorder(QStringList{}, 4096);
        QVERIFY(!recorder.start());
        QCOMPARE(recorder.error(), u"لا يوجد مسجّل صوت مثبّت (pacat أو pw-record)."_s);
    }

    void updateCountsUseArabicPlurals()
    {
        SystemModel system;
        system.applyUpdateCounts(2, 2);
        QCOMPARE(system.updatesText(), u"تحديثان · تحديثان أمنيان"_s);
        system.applyUpdateCounts(11, 3);
        QCOMPARE(system.updatesText(), u"11 تحديثًا · 3 تحديثات أمنية"_s);
    }

    void auditTimesUseArabicMonthsAndLatinDigits()
    {
        const QDateTime now(QDate(2026, 10, 9), QTime(12, 0));
        const QDateTime then(QDate(2026, 10, 7), QTime(9, 5));
        QCOMPARE(AuditModel::formatTime(then.toMSecsSinceEpoch(), now), u"7 أكتوبر 09:05"_s);
    }
};

QTEST_MAIN(TestShellTranslations)
#include "tst_shelltranslations.moc"
