#include <QQmlContext>
#include <QQmlEngine>
#include <QQuickStyle>
#include <QtQml/qqmlextensionplugin.h>
#include <QtQuickTest>

#include "AppsModel.h"
#include "ClassicController.h"
#include "Language.h"
#include "AppLauncher.h"
#include "app/AppFont.h"
#include "app/ShellController.h"
#include "control/ControlClient.h"

Q_IMPORT_QML_PLUGIN(JarvisShellPlugin)
Q_IMPORT_QML_PLUGIN(JarvisClassicPlugin)

// Records what the classic desktop would have started.
class Starts : public QObject {
    Q_OBJECT
    Q_PROPERTY(QStringList all READ all NOTIFY changed)
public:
    using QObject::QObject;
    QStringList all() const { return m_all; }
    void add(const QString& line)
    {
        m_all.append(line);
        emit changed();
    }
signals:
    void changed();

private:
    QStringList m_all;
};

class Setup : public QObject {
    Q_OBJECT
public slots:
    void applicationAvailable()
    {
        QQuickStyle::setStyle(QStringLiteral("Basic"));
        applyShellFont();
        qputenv("JARVIS_I18N_DIR", QByteArrayLiteral(JARVIS_TEST_I18N_DIR));
    }
    void qmlEngineAvailable(QQmlEngine* engine)
    {
        engine->addImportPath(QStringLiteral(JARVIS_QML_DIR));
        ControlOptions options; // never connects: classic without jarvisd
        options.socketPath = QStringLiteral("/tmp/jcl-no-daemon/jarvisd.sock");
        options.secretPath = QStringLiteral("/tmp/jcl-no-daemon/control.secret");
        auto* client = new ControlClient(options, engine);
        auto* shell = new ShellController(client, engine);
        shell->setLauncher([](const QString&) { return true; });

        auto* language = new jarvis::ui::LanguageManager(
            {QStringLiteral("jarvis-ui"), QStringLiteral("jarvis-shell"), QStringLiteral("jarvis-classic")}, engine);
        QObject::connect(language, &jarvis::ui::LanguageManager::languageChanged, engine, &QQmlEngine::retranslate);
        shell->setLanguageApplier([language](const QString& code) { return language->setLanguage(code); }, language->language());

        auto* apps = new AppsModel({QStringLiteral(JARVIS_CLASSIC_TEST_DATA "/applications")}, {QStringLiteral("labwc")}, engine);
        QObject::connect(language, &jarvis::ui::LanguageManager::languageChanged, apps, &AppsModel::retranslate);
        auto* starts = new Starts(engine);
        auto* launcher = new AppLauncher(engine);
        launcher->setStarter([starts](const QString& program, const QStringList& args) {
            starts->add((QStringList{program} + args).join(u' '));
            return true;
        });
        auto* controller = new ClassicController(apps, launcher, /*fallback*/ true, engine);
        controller->setShell(shell);

        engine->rootContext()->setContextProperty(QStringLiteral("testController"), controller);
        engine->rootContext()->setContextProperty(QStringLiteral("testLanguage"), language);
        engine->rootContext()->setContextProperty(QStringLiteral("testStarts"), starts);
    }
};

QUICK_TEST_MAIN_WITH_SETUP(jarvis_classic_qml, Setup)

#include "tst_qml.moc"
