#pragma once

#include <QAbstractListModel>
#include <QJsonObject>
#include <QtQml/qqmlregistration.h>

// Network doctor progress (contracts §3.3 DoctorState), from doctor:start /
// doctor:skip answers and doctor:state pushes. Fixes arrive as ordinary cards.
class DoctorModel : public QAbstractListModel {
    Q_OBJECT
    QML_ELEMENT
    Q_PROPERTY(bool started READ started NOTIFY stateChanged)
    Q_PROPERTY(bool active READ active NOTIFY stateChanged)
    Q_PROPERTY(QString done READ done NOTIFY stateChanged)
    Q_PROPERTY(QVariantList networks READ networks NOTIFY stateChanged)

public:
    enum Role { StepIdRole = Qt::UserRole + 1, LabelRole, StatusRole, DetailRole, NumberRole };
    Q_ENUM(Role)

    explicit DoctorModel(QObject* parent = nullptr);

    int rowCount(const QModelIndex& parent = {}) const override;
    QVariant data(const QModelIndex& index, int role) const override;
    QHash<int, QByteArray> roleNames() const override;

    bool started() const { return m_started; }
    bool active() const { return m_active; }
    QString done() const { return m_done; }
    QVariantList networks() const { return m_networks; }

    Q_INVOKABLE void applyState(const QJsonObject& state);
    Q_INVOKABLE void start();
    Q_INVOKABLE void skip(const QString& stepId);
    Q_INVOKABLE void reset();

signals:
    void stateChanged();
    void startRequested();
    void skipRequested(const QString& stepId);

private:
    struct Step {
        QString stepId, label, status, detail;
    };
    QList<Step> m_steps;
    bool m_started = false;
    bool m_active = false;
    QString m_done;
    QVariantList m_networks;
};
