#pragma once

#include <QAbstractListModel>
#include <QJsonObject>
#include <QStringList>
#include <QtQml/qqmlregistration.h>

// Rafiq v1.1 contracts §2 cu:state: what Jarvis is doing on the screen, for
// the overlay (border, status pill, step panel, Take over). Every string in a
// push is model output and untrusted: whitespace collapsed, control and
// format characters (bidi overrides) removed, length capped, shown as plain text.
class CuSessionModel : public QAbstractListModel {
    Q_OBJECT
    QML_ELEMENT
    Q_PROPERTY(bool active READ active NOTIFY changed)
    Q_PROPERTY(bool visible READ visible NOTIFY changed)
    Q_PROPERTY(bool running READ running NOTIFY changed)
    Q_PROPERTY(bool paused READ paused NOTIFY changed)
    Q_PROPERTY(bool connectionLost READ connectionLost NOTIFY changed)
    Q_PROPERTY(bool busy READ busy NOTIFY changed)
    Q_PROPERTY(QString sessionId READ sessionId NOTIFY changed)
    Q_PROPERTY(QString goal READ goal NOTIFY changed)
    Q_PROPERTY(QStringList apps READ apps NOTIFY changed)
    Q_PROPERTY(QString appsText READ appsText NOTIFY changed)
    Q_PROPERTY(int step READ step NOTIFY changed)
    Q_PROPERTY(int maxSteps READ maxSteps NOTIFY changed)
    Q_PROPERTY(QString pauseReason READ pauseReason NOTIFY changed)
    Q_PROPERTY(QString statusText READ statusText NOTIFY changed)
    Q_PROPERTY(QString detailText READ detailText NOTIFY changed)
    Q_PROPERTY(QString error READ error NOTIFY changed)

public:
    enum Role { TitleRole = Qt::UserRole + 1, StatusRole, StatusLabelRole };
    Q_ENUM(Role)

    explicit CuSessionModel(QObject* parent = nullptr);

    int rowCount(const QModelIndex& parent = {}) const override;
    QVariant data(const QModelIndex& index, int role) const override;
    QHash<int, QByteArray> roleNames() const override;

    bool active() const { return m_active; }
    bool visible() const { return m_active; } // stays up while the connection is lost
    bool running() const { return m_active && !m_paused && !m_connectionLost; }
    bool paused() const { return m_paused; }
    bool connectionLost() const { return m_connectionLost; }
    bool busy() const { return m_pending != Pending::None; }
    QString sessionId() const { return m_sessionId; }
    QString goal() const { return m_goal; }
    QStringList apps() const { return m_apps; }
    QString appsText() const;
    int step() const { return m_step; }
    int maxSteps() const { return m_maxSteps; }
    QString pauseReason() const { return m_pauseReason; }
    QString statusText() const;
    QString detailText() const;
    QString error() const { return m_error; }

    Q_INVOKABLE void applyState(const QJsonObject& state);
    Q_INVOKABLE void stop();   // Take over / Stop -> cu:stop
    Q_INVOKABLE void resume(); // Resume (paused only) -> cu:resume
    Q_INVOKABLE void connectionClosed();
    Q_INVOKABLE void connectionOpened();
    void applyRequestResult(bool ok, const QString& text);

    static QString cleanText(const QString& raw, int maxLength);

signals:
    void changed();
    void runningChanged();
    void stopRequested();
    void resumeRequested();

private:
    enum class Pending { None, Stop, Resume };
    struct Step {
        QString title;
        QString status;
    };
    void clear();
    QString statusLabel(const QString& status) const;

    QList<Step> m_steps;
    bool m_active = false;
    bool m_paused = false;
    bool m_connectionLost = false;
    Pending m_pending = Pending::None;
    QString m_sessionId;
    QString m_goal;
    QStringList m_apps;
    int m_step = 0;
    int m_maxSteps = 50;
    QString m_pauseReason;
    QString m_error;
};
