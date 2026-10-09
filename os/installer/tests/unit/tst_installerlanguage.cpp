#include <QSignalSpy>
#include <QtTest>

#include "FakeInstallerBackend.h"
#include "FakePower.h"
#include "InstallerModel.h"
#include "LocaleChoice.h"

using namespace Qt::StringLiterals;

namespace {
struct Rig {
    FakeInstallerBackend backend;
    FakePower power;
    InstallerModel model{&backend, &power, u"Rafiq"_s, u"en_US"_s, "Africa/Cairo"};
    QStringList applied;
    bool arabicInstalled = true;
    Rig()
    {
        model.setLanguageApplier([this](const QString& code) {
            if (code == u"ar" && !arabicInstalled)
                return false;
            applied << code;
            return true;
        });
    }
};
} // namespace

class TestInstallerLanguage : public QObject {
    Q_OBJECT
private slots:
    void startsInTheWelcomeLanguage()
    {
        Rig rig;
        QCOMPARE(rig.model.uiLanguage(), u"en"_s);
        QCOMPARE(rig.applied, QStringList{u"en"_s});
    }

    void arabicOnWelcomeSwitchesAtOnce()
    {
        Rig rig;
        QSignalSpy changed(&rig.model, &InstallerModel::languageChanged);
        rig.model.locale()->setLanguage(u"ar_EG.UTF-8"_s);
        QCOMPARE(rig.model.uiLanguage(), u"ar"_s);
        QCOMPARE(rig.applied, (QStringList{u"en"_s, u"ar"_s}));
        QCOMPARE(changed.size(), 1);
        rig.model.locale()->setLanguage(u"fr_FR.UTF-8"_s); // French UI is English
        QCOMPARE(rig.model.uiLanguage(), u"en"_s);
        rig.model.locale()->setLanguage(u"de_DE.UTF-8"_s); // still English: nothing re-applied
        QCOMPARE(rig.applied, (QStringList{u"en"_s, u"ar"_s, u"en"_s}));
    }

    void missingArabicKeepsEnglish()
    {
        Rig rig;
        rig.arabicInstalled = false;
        rig.model.locale()->setLanguage(u"ar_EG.UTF-8"_s);
        QCOMPARE(rig.model.uiLanguage(), u"en"_s);
        QCOMPARE(rig.model.locale()->language(), u"ar_EG.UTF-8"_s); // the target still gets ar_EG
    }

    void languageNamesStayInTheirOwnScript()
    {
        Rig rig;
        QStringList names;
        for (const QVariant& v : rig.model.locale()->languages())
            names << v.toMap().value(u"text"_s).toString();
        QVERIFY(names.contains(u"العربية"_s));
        QVERIFY(names.contains(u"English"_s));
        QVERIFY(names.contains(u"Français"_s));
    }
};

QTEST_MAIN(TestInstallerLanguage)
#include "tst_installerlanguage.moc"
