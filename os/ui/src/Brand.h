#pragma once

#include <QObject>
#include <QString>
#include <QtQml/qqmlregistration.h>

// The public distro name for UI text: /etc/os-release NAME, fallback
// "Rafiq" (contracts §9; jarvis::ui::distroName). "Jarvis" the assistant is not this.
class Brand : public QObject {
    Q_OBJECT
    QML_ELEMENT
    QML_SINGLETON
    Q_PROPERTY(QString distroName READ distroName CONSTANT)

public:
    explicit Brand(QObject* parent = nullptr);
    QString distroName() const { return m_distroName; }

private:
    QString m_distroName;
};
