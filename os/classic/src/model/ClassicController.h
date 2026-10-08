#pragma once

#include <QObject>
#include <QtQml/qqmlregistration.h>

#include "AppsModel.h"

class Launcher;

// State of the classic desktop (Rafiq M4 contracts §2): taskbar buttons, the
// Apps menu and the docked Jarvis panel. Programs: foot, pcmanfm-qt,
// `jarvis-shell --settings`.
class ClassicController : public QObject {
    Q_OBJECT
    QML_ELEMENT
    QML_UNCREATABLE("Created by main()")
    Q_PROPERTY(AppsModel* apps READ apps CONSTANT)
    Q_PROPERTY(bool appsOpen READ appsOpen NOTIFY appsOpenChanged)
    Q_PROPERTY(bool chatOpen READ chatOpen NOTIFY chatOpenChanged)
    Q_PROPERTY(bool fallback READ fallback CONSTANT)
    Q_PROPERTY(QString notice READ notice NOTIFY noticeChanged)

public:
    ClassicController(AppsModel* apps, Launcher* launcher, bool fallback, QObject* parent = nullptr);

    AppsModel* apps() const { return m_apps; }
    bool appsOpen() const { return m_appsOpen; }
    bool chatOpen() const { return m_chatOpen; }
    bool fallback() const { return m_fallback; }
    QString notice() const { return m_notice; }

    Q_INVOKABLE void openTerminal();
    Q_INVOKABLE void openFiles();
    Q_INVOKABLE void openSettings();
    Q_INVOKABLE void launchApp(const QString& id);
    Q_INVOKABLE void launchFirst();
    Q_INVOKABLE void toggleApps();
    Q_INVOKABLE void closeApps();
    Q_INVOKABLE void toggleChat();
    Q_INVOKABLE void openChat();
    Q_INVOKABLE void closeChat();
    Q_INVOKABLE void dismissNotice();

    static QString defaultMarkerPath();
    static bool fallbackActive(const QString& markerPath);

signals:
    void appsOpenChanged();
    void chatOpenChanged();
    void noticeChanged();

private:
    void setAppsOpen(bool open);
    void setChatOpen(bool open);
    void setNotice(const QString& notice);

    AppsModel* m_apps;
    Launcher* m_launcher;
    bool m_fallback;
    bool m_appsOpen = false;
    bool m_chatOpen = false;
    QString m_notice;
};
