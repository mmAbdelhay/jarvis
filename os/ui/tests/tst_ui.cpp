#include <QQmlEngine>
#include <QQuickStyle>
#include <QtQuickTest>

class Setup : public QObject {
    Q_OBJECT
public slots:
    void applicationAvailable()
    {
        QQuickStyle::setStyle(QStringLiteral("Basic"));
        qputenv("JARVIS_OS_RELEASE", QByteArrayLiteral(JARVIS_TEST_OS_RELEASE));
    }
    void qmlEngineAvailable(QQmlEngine* engine) { engine->addImportPath(QStringLiteral(JARVIS_QML_DIR)); }
};

QUICK_TEST_MAIN_WITH_SETUP(jarvis_ui_qml, Setup)

#include "tst_ui.moc"
