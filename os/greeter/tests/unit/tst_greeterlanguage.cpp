#include <QSignalSpy>
#include <QtTest>

#include "GreeterLanguage.h"

using namespace Qt::StringLiterals;

class TestGreeterLanguage : public QObject {
    Q_OBJECT
private slots:
    void init()
    {
        qunsetenv("LANG");
        qunsetenv("LANGUAGE");
    }

    void localeFileDecidesWithoutEnvironment()
    {
        QCOMPARE(GreeterLanguage::systemLanguage(QStringLiteral(JARVIS_GREETER_TEST_DATA "/locale-ar")), u"ar"_s);
        QCOMPARE(GreeterLanguage::systemLanguage(QStringLiteral(JARVIS_GREETER_TEST_DATA "/locale-quoted")), u"en"_s);
        QCOMPARE(GreeterLanguage::systemLanguage(u"/nonexistent/locale"_s), u"en"_s);
    }

    void localeFileWinsOverEnvironment()
    {
        qputenv("LANG", "en_US.UTF-8");
        QCOMPARE(GreeterLanguage::systemLanguage(QStringLiteral(JARVIS_GREETER_TEST_DATA "/locale-ar")), u"ar"_s);
        QCOMPARE(GreeterLanguage::systemLanguage(u"/nonexistent/locale"_s), u"en"_s);
        qputenv("LANG", "C.UTF-8");
        QCOMPARE(GreeterLanguage::systemLanguage(QStringLiteral(JARVIS_GREETER_TEST_DATA "/locale-ar")), u"ar"_s);
    }

    void cLanguageFallsBackToFile()
    {
        qputenv("LANGUAGE", "C");
        qputenv("LANG", "POSIX");
        QCOMPARE(GreeterLanguage::systemLanguage(QStringLiteral(JARVIS_GREETER_TEST_DATA "/locale-ar")), u"ar"_s);
    }

    void sessionLocalePreservesSystemUnlessLanguageDiffers()
    {
        const QString british = QStringLiteral(JARVIS_GREETER_TEST_DATA "/locale-quoted");
        const QString arabic = QStringLiteral(JARVIS_GREETER_TEST_DATA "/locale-ar");
        qputenv("LANG", "en_US.UTF-8");
        QCOMPARE(GreeterLanguage::sessionLocale(u"en"_s, british), u"en_GB.UTF-8"_s);
        QCOMPARE(GreeterLanguage::sessionLocale(u"ar"_s, british), u"ar_EG.UTF-8"_s);
        QCOMPARE(GreeterLanguage::sessionLocale(u"en"_s, british), u"en_GB.UTF-8"_s);
        QCOMPARE(GreeterLanguage::sessionLocale(u"ar"_s, arabic), u"ar_EG.UTF-8"_s);
        QCOMPARE(GreeterLanguage::sessionLocale(u"en"_s, arabic), u"en_US.UTF-8"_s);
        qputenv("LANG", "en_GB.UTF-8");
        QCOMPARE(GreeterLanguage::sessionLocale(u"en"_s, u"/nonexistent/locale"_s), u"en_GB.UTF-8"_s);
    }

    void toggleSwitchesBothWays()
    {
        QStringList applied;
        GreeterLanguage language([&](const QString& code) { applied << code; return true; }, u"en"_s);
        QSignalSpy changed(&language, &GreeterLanguage::changed);
        QCOMPARE(language.otherLanguageName(), u"العربية"_s);
        language.toggle();
        QCOMPARE(language.language(), u"ar"_s);
        QCOMPARE(language.otherLanguageName(), u"English"_s);
        language.toggle();
        QCOMPARE(applied, (QStringList{u"ar"_s, u"en"_s}));
        QCOMPARE(changed.size(), 2);
    }

    void refusedSwitchStaysPut()
    {
        GreeterLanguage language([](const QString& code) { return code == u"en"; }, u"en"_s);
        language.toggle();
        QCOMPARE(language.language(), u"en"_s);
    }
};

QTEST_GUILESS_MAIN(TestGreeterLanguage)
#include "tst_greeterlanguage.moc"
