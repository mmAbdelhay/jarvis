#pragma once

#include <QObject>
#include <QString>
#include <QtQml/qqmlregistration.h>

// The public distro name for UI text, in the app's language (M4 contracts
// §6.8): /usr/share/jarvis/brand.json name[lang], else /etc/os-release NAME,
// else "Rafiq" (contracts §9; jarvis::ui::localizedDistroName). Re-read on a
// language switch. "Jarvis" the assistant is not this.
class Brand : public QObject {
    Q_OBJECT
    QML_ELEMENT
    QML_SINGLETON
    Q_PROPERTY(QString distroName READ distroName NOTIFY changed)

public:
    explicit Brand(QObject* parent = nullptr);
    QString distroName() const { return m_distroName; }

signals:
    void changed();

protected:
    bool eventFilter(QObject* watched, QEvent* event) override;

private:
    QString m_distroName;
};
