#pragma once

#include <QJsonArray>
#include <QList>
#include <QObject>
#include <QVariantList>
#include <QtQml/qqmlregistration.h>

// Installing screen state, fed by Progress/ModelProgress/Finished
// (contracts §1). The plan's "model" step runs in parallel and is shown on
// its own line; the other steps run in plan order.
class InstallProgress : public QObject {
    Q_OBJECT
    QML_ELEMENT
    QML_UNCREATABLE("Owned by InstallerModel")
    Q_PROPERTY(QVariantList rows READ rows NOTIFY changed)
    Q_PROPERTY(QString currentTitle READ currentTitle NOTIFY changed)
    Q_PROPERTY(int currentPercent READ currentPercent NOTIFY changed)
    Q_PROPERTY(QString currentDetail READ currentDetail NOTIFY changed)
    Q_PROPERTY(bool modelVisible READ modelVisible NOTIFY changed)
    Q_PROPERTY(QString modelTitle READ modelTitle NOTIFY changed)
    Q_PROPERTY(int modelPercent READ modelPercent NOTIFY changed)
    Q_PROPERTY(QString modelDetail READ modelDetail NOTIFY changed)
    Q_PROPERTY(bool done READ done NOTIFY changed)
    Q_PROPERTY(bool failed READ failed NOTIFY changed)
    Q_PROPERTY(QString failTitle READ failTitle NOTIFY changed)
    Q_PROPERTY(QString failMessage READ failMessage NOTIFY changed)
    Q_PROPERTY(QString finishNote READ finishNote NOTIFY changed)

public:
    explicit InstallProgress(QObject* parent = nullptr);

    QVariantList rows() const;
    QString currentTitle() const { return m_currentTitle; }
    int currentPercent() const { return m_currentPercent; }
    QString currentDetail() const { return m_currentDetail; }
    bool modelVisible() const { return !m_modelTitle.isEmpty(); }
    QString modelTitle() const { return m_modelTitle; }
    int modelPercent() const { return m_modelPercent; }
    QString modelDetail() const { return m_modelDetail; }
    bool done() const { return m_done; }
    bool failed() const { return m_failed; }
    QString failTitle() const { return m_failTitle; }
    QString failMessage() const { return m_failMessage; }
    QString finishNote() const { return m_finishNote; }

    void setPlanSteps(const QJsonArray& steps);
    void applyProgress(const QString& stepId, int percent, const QString& detail);
    void applyModelProgress(int percent, const QString& detail);
    void finish(bool ok, const QString& errorStep, const QString& message);

signals:
    void changed();

private:
    struct Row {
        QString stepId, title, state;
    };
    QList<Row> m_rows;
    QString m_currentTitle, m_currentDetail;
    int m_currentPercent = 0;
    QString m_modelTitle, m_modelDetail;
    int m_modelPercent = 0;
    bool m_done = false;
    bool m_failed = false;
    QString m_failTitle, m_failMessage, m_finishNote;
};
