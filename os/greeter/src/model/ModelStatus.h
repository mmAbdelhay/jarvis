#pragma once

#include <QFileSystemWatcher>
#include <QObject>
#include <QTimer>
#include <QtQml/qqmlregistration.h>

// The login screen's status line (spec §6, contracts §5), read from the
// world-readable model-state.json written by the installer backend and
// jarvis-model-fetch — never from the user's jarvisd, which isn't running yet.
// Missing, half-written or unknown content hides the line.
class ModelStatus : public QObject {
    Q_OBJECT
    QML_ELEMENT
    QML_UNCREATABLE("Created by main()")
    Q_PROPERTY(bool shown READ shown NOTIFY changed)
    Q_PROPERTY(bool ready READ ready NOTIFY changed)
    Q_PROPERTY(QString text READ text NOTIFY changed)

public:
    ModelStatus(QString statePath, QString catalogPath, QObject* parent = nullptr);
    static QString defaultStatePath();
    static QString defaultCatalogPath();

    bool shown() const { return m_shown; }
    bool ready() const { return m_ready; }
    QString text() const { return m_text; }
    Q_INVOKABLE void reload();

signals:
    void changed();

private:
    QString modelName(const QString& modelId, const QString& tag) const;
    void watch();

    QString m_statePath, m_catalogPath;
    QFileSystemWatcher m_watcher;
    QTimer m_poll;
    bool m_shown = false;
    bool m_ready = false;
    QString m_text;
};
