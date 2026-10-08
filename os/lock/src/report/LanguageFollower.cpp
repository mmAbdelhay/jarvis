#include "report/LanguageFollower.h"

#include <QJsonObject>

#include "Language.h"
#include "control/ControlClient.h"

LanguageFollower::LanguageFollower(ControlClient* client, std::function<bool(const QString&)> apply, QObject* parent)
    : QObject(parent)
    , m_apply(std::move(apply))
{
    connect(client, &ControlClient::push, this, [this](const QString& channel, const QJsonValue& payload) {
        if (channel != u"ui:language" || !payload.isObject())
            return;
        const QJsonValue lang = payload.toObject().value("lang");
        if (lang.isString() && jarvis::ui::isSupportedLanguage(lang.toString()))
            m_apply(lang.toString());
    });
}
