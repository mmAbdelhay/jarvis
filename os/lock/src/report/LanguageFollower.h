#pragma once

#include <QObject>
#include <functional>

class ControlClient;

// The lock screen follows jarvisd's ui:language push (Rafiq M4 contracts §3)
// while it is shown. It only listens: jarvis-lock sends sys:setLocked and
// nothing else (M3 contracts §3).
class LanguageFollower : public QObject {
    Q_OBJECT
public:
    LanguageFollower(ControlClient* client, std::function<bool(const QString& code)> apply, QObject* parent = nullptr);

private:
    std::function<bool(const QString&)> m_apply;
};
