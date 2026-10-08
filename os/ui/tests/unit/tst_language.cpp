#include <QDateTime>
#include <QFont>
#include <QGuiApplication>
#include <QSignalSpy>
#include <QTemporaryDir>
#include <QtTest>

#include "Language.h"

using namespace Qt::StringLiterals;
using namespace jarvis::ui;

class TestLanguage : public QObject {
    Q_OBJECT
private slots:
    void init() { qputenv("JARVIS_I18N_DIR", JARVIS_TEST_I18N_DIR); }

    void environmentPicksTheLanguage_data()
    {
        QTest::addColumn<QString>("languageVar");
        QTest::addColumn<QString>("langVar");
        QTest::addColumn<QString>("expected");
        QTest::newRow("arabic LANG") << QString() << u"ar_EG.UTF-8"_s << u"ar"_s;
        QTest::newRow("english LANG") << QString() << u"en_GB.UTF-8"_s << u"en"_s;
        QTest::newRow("LANGUAGE wins") << u"ar:en"_s << u"en_US.UTF-8"_s << u"ar"_s;
        QTest::newRow("LANGUAGE skips unknown") << u"fr:ar"_s << u"C.UTF-8"_s << u"ar"_s;
        QTest::newRow("C locale") << QString() << u"C.UTF-8"_s << u"en"_s;
        QTest::newRow("POSIX") << QString() << u"POSIX"_s << u"en"_s;
        QTest::newRow("unsupported") << u"de"_s << u"fr_FR.UTF-8"_s << u"en"_s;
        QTest::newRow("empty") << QString() << QString() << u"en"_s;
        QTest::newRow("modifier") << QString() << u"ar_SA.UTF-8@euro"_s << u"ar"_s;
        QTest::newRow("bidi junk") << u"‮ar"_s << QString() << u"en"_s;
    }
    void environmentPicksTheLanguage()
    {
        QFETCH(QString, languageVar);
        QFETCH(QString, langVar);
        QFETCH(QString, expected);
        QCOMPARE(languageFromEnvironment(languageVar, langVar), expected);
    }

    void localeMapsToUiLanguage()
    {
        QCOMPARE(languageForLocale(u"ar_EG.UTF-8"_s), u"ar"_s);
        QCOMPARE(languageForLocale(u"fr_FR.UTF-8"_s), u"en"_s);
        QCOMPARE(languageForLocale(u"en_US.UTF-8"_s), u"en"_s);
    }

    void latinDigitsReplacesArabicIndic()
    {
        QCOMPARE(latinDigits(u"٠١٢٣٤٥٦٧٨٩ ۴۲ ١٢٫٥ ١٬٠٠٠"_s), u"0123456789 42 12.5 1,000"_s);
        QCOMPARE(latinDigits(u"Wi-Fi 42%"_s), u"Wi-Fi 42%"_s);
    }

    void formatsDatesInTheLanguage()
    {
        const QDateTime when(QDate(2026, 10, 7), QTime(9, 5));
        QCOMPARE(formatDateTime(when, u"dddd, d MMMM"_s, u"en"_s), u"Wednesday, 7 October"_s);
        QCOMPARE(formatDateTime(when, u"dddd، d MMMM"_s, u"ar"_s), u"الأربعاء، 7 أكتوبر"_s);
        QCOMPARE(formatDateTime(when, u"HH:mm"_s, u"ar"_s), u"09:05"_s);
    }

    void appliesArabicThenEnglish()
    {
        LanguageManager manager({u"demo"_s});
        QSignalSpy changed(&manager, &LanguageManager::languageChanged);
        QVERIFY(manager.setLanguage(u"ar"_s));
        QCOMPARE(manager.language(), u"ar"_s);
        QVERIFY(manager.rightToLeft());
        QCOMPARE(QCoreApplication::translate("Demo", "Hello"), u"مرحبًا"_s);
        QCOMPARE(QGuiApplication::layoutDirection(), Qt::RightToLeft);
        QCOMPARE(currentLanguage(), u"ar"_s);
        QCOMPARE(QGuiApplication::font().families().value(0), u"IBM Plex Sans Arabic"_s);
        QCOMPARE(changed.size(), 1);

        QVERIFY(manager.setLanguage(u"ar"_s)); // same language: no second signal
        QCOMPARE(changed.size(), 1);

        QVERIFY(manager.setLanguage(u"en"_s));
        QCOMPARE(QCoreApplication::translate("Demo", "Hello"), u"Hello"_s);
        QCOMPARE(QGuiApplication::layoutDirection(), Qt::LeftToRight);
        QCOMPARE(QGuiApplication::font().families().value(0), u"IBM Plex Sans"_s);
        QCOMPARE(currentLanguage(), u"en"_s);
        QCOMPARE(changed.size(), 2);
    }

    void unsupportedCodeChangesNothing()
    {
        LanguageManager manager({u"demo"_s});
        QVERIFY(manager.setLanguage(u"en"_s));
        QSignalSpy changed(&manager, &LanguageManager::languageChanged);
        for (const QString& bad : {u"fr"_s, u"AR"_s, u"ar‮"_s, QString(), u"ar_EG"_s})
            QVERIFY(!manager.setLanguage(bad));
        QCOMPARE(manager.language(), u"en"_s);
        QCOMPARE(changed.size(), 0);
    }

    void missingOwnCatalogKeepsEnglish()
    {
        QTemporaryDir empty;
        qputenv("JARVIS_I18N_DIR", empty.path().toUtf8());
        LanguageManager manager({u"demo"_s});
        QVERIFY(manager.setLanguage(u"en"_s)); // English needs no catalog
        QVERIFY(!manager.setLanguage(u"ar"_s));
        QCOMPARE(manager.language(), u"en"_s);
        QCOMPARE(QGuiApplication::layoutDirection(), Qt::LeftToRight);
        QCOMPARE(currentLanguage(), u"en"_s);
    }

    void sendsLanguageChangeToTheApplication()
    {
        struct Catcher : QObject {
            int count = 0;
            bool eventFilter(QObject*, QEvent* e) override
            {
                if (e->type() == QEvent::LanguageChange)
                    ++count;
                return false;
            }
        } catcher;
        QCoreApplication::instance()->installEventFilter(&catcher);
        LanguageManager manager({u"demo"_s});
        QVERIFY(manager.setLanguage(u"ar"_s));
        QVERIFY(catcher.count >= 1);
        QVERIFY(manager.setLanguage(u"en"_s));
        QCoreApplication::instance()->removeEventFilter(&catcher);
    }
};

QTEST_MAIN(TestLanguage)
#include "tst_language.moc"
