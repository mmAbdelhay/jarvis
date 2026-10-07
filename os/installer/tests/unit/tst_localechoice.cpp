#include <QSignalSpy>
#include <algorithm>
#include <QtTest>

#include "LocaleChoice.h"

using namespace Qt::StringLiterals;

namespace {
bool hasValue(const QVariantList& options, const QString& value)
{
    return std::any_of(options.cbegin(), options.cend(), [&](const QVariant& o) { return o.toMap().value(u"value"_s) == value; });
}
} // namespace

class TestLocaleChoice : public QObject {
    Q_OBJECT
private slots:
    void defaultsFromTheSystem()
    {
        LocaleChoice ar(u"ar_EG"_s, "Africa/Cairo");
        QCOMPARE(ar.language(), u"ar_EG.UTF-8"_s);
        QCOMPARE(ar.keyboard(), u"ara"_s);
        QCOMPARE(ar.timezone(), u"Africa/Cairo"_s);
        LocaleChoice c(u"C"_s, "Nowhere/Land");
        QCOMPARE(c.language(), u"en_US.UTF-8"_s);
        QCOMPARE(c.keyboard(), u"us"_s);
        QCOMPARE(c.timezone(), u"UTC"_s);
    }

    void listsAreOffered()
    {
        LocaleChoice locale(u"en_US"_s, "UTC");
        QCOMPARE(locale.languages().size(), 5);
        QVERIFY(hasValue(locale.keyboards(), u"gb"_s));
        QVERIFY(hasValue(locale.timezones(), u"Africa/Cairo"_s));
        QVERIFY(hasValue(locale.timezones(), u"UTC"_s));
        QVERIFY(!hasValue(locale.timezones(), u"Etc/GMT+3"_s));
    }

    void keyboardFollowsLanguageUntilChosen()
    {
        LocaleChoice locale(u"en_US"_s, "UTC");
        locale.setLanguage(u"fr_FR.UTF-8"_s);
        QCOMPARE(locale.keyboard(), u"fr"_s);
        QCOMPARE(locale.timezone(), u"Europe/Paris"_s);
        locale.setKeyboard(u"gb"_s);
        QCOMPARE(locale.timezone(), u"Europe/London"_s);
        locale.setLanguage(u"de_DE.UTF-8"_s);
        QCOMPARE(locale.keyboard(), u"gb"_s);
        locale.setLanguage(u"xx_XX.UTF-8"_s);
        QCOMPARE(locale.language(), u"de_DE.UTF-8"_s);
        locale.setKeyboard(u"dvorak-nonsense"_s);
        QCOMPARE(locale.keyboard(), u"gb"_s);
    }

    void geoTimezoneUnlessChosen()
    {
        LocaleChoice locale(u"en_US"_s, "UTC");
        QSignalSpy changed(&locale, &LocaleChoice::changed);
        locale.applyProbe(QJsonObject{{"geoTimezone", "Asia/Riyadh"}});
        QCOMPARE(locale.timezone(), u"Asia/Riyadh"_s);
        QCOMPARE(changed.size(), 1);
        locale.setTimezone(u"Europe/London"_s);
        locale.applyProbe(QJsonObject{{"geoTimezone", "Africa/Cairo"}});
        QCOMPARE(locale.timezone(), u"Europe/London"_s);
        locale.applyProbe(QJsonObject{{"geoTimezone", QJsonValue::Null}});
        QCOMPARE(locale.timezone(), u"Europe/London"_s);
    }
};

QTEST_GUILESS_MAIN(TestLocaleChoice)
#include "tst_localechoice.moc"
