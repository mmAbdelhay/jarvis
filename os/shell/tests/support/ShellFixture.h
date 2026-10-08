#pragma once

// A shell wired to a FakeDaemon, connected and on the chat view (provider
// configured). Header-only so the support/*.cpp glob is unchanged.

#include <QDateTime>
#include <QHash>
#include <QJsonArray>
#include <QJsonObject>
#include <QtTest>
#include <memory>

#include "FakeDaemon.h"
#include "app/ShellController.h"
#include "control/ControlClient.h"
#include "models/Conversation.h"

namespace fixture {
inline QJsonObject snapshot(bool locked, bool voice = false)
{
    return {{"online", true},
            {"network", QJsonObject{{"connectivity", "full"}, {"wifiSsid", QJsonValue::Null}}},
            {"memTotalBytes", 0}, {"memUsedBytes", 0}, {"disk", QJsonObject{}}, {"failedUnits", QJsonArray{}},
            {"model", QJsonValue::Null}, {"locked", locked},
            {"voice", QJsonObject{{"available", voice}, {"stt", voice ? "whisper base" : ""},
                                  {"tts", voice ? "en_US-amy-medium" : ""}}}};
}

inline QJsonObject item(const QString& id, const QString& tool = QStringLiteral("settings.brightness"),
                        const QString& risk = QStringLiteral("confirm"), const QJsonArray& secretFields = {})
{
    return {{"itemId", id}, {"tool", tool}, {"title", "Do " + id}, {"detail", "40% → 70%"},
            {"source", "system"}, {"risk", risk}, {"secretFields", secretFields}};
}

inline QJsonObject card(const QString& cardId, const QJsonArray& items, const QJsonValue& turnId = QStringLiteral("t1"))
{
    return {{"cardId", cardId}, {"turnId", turnId},
            {"expiresAt", double(QDateTime::currentMSecsSinceEpoch() + 300000)}, {"items", items}};
}

inline QJsonObject providerList()
{
    return {{"providers", QJsonArray{QJsonObject{{"id", "local"}, {"kind", "ollama"}, {"baseUrl", "http://localhost:11434"},
                                                 {"model", "qwen3:8b"}, {"hasKey", false}}}},
            {"activeId", "local"}, {"allowCloudFallback", false},
            {"kinds", QJsonArray{"anthropic", "openai-compatible", "ollama", "gemini"}}};
}
} // namespace fixture

struct ShellFixture {
    FakeDaemon daemon;
    QHash<QString, FakeDaemon::Reply> replies; // per channel; defaults below
    std::unique_ptr<ControlClient> client;
    std::unique_ptr<ShellController> shell;

    ShellFixture()
    {
        replies.insert(QStringLiteral("provider:list"), {true, fixture::providerList()});
        replies.insert(QStringLiteral("audit:list"), {true, QJsonArray{}});
        replies.insert(QStringLiteral("memory:list"), {true, QJsonArray{}});
        replies.insert(QStringLiteral("registry:list"), {true, QJsonObject{{"installed", QJsonArray{}}, {"available", QJsonArray{}}}});
        replies.insert(QStringLiteral("agent:prompt"), {true, QJsonObject{{"turnId", "t1"}}});
        daemon.handler = [this](const QString& channel, const QJsonArray&, quint64) -> FakeDaemon::Reply {
            return replies.value(channel, FakeDaemon::Reply{true, QJsonValue::Null});
        };
        daemon.listen();
        ControlOptions options;
        options.socketPath = daemon.socketPath();
        options.secretPath = daemon.secretPath();
        options.backoffMs = {20};
        client = std::make_unique<ControlClient>(options);
        shell = std::make_unique<ShellController>(client.get());
        shell->setLauncher([](const QString&) { return true; });
    }

    bool open()
    {
        client->start();
        return QTest::qWaitFor([this] { return shell->connection() == u"open" && shell->view() == u"chat"; }, 3000);
    }
    void push(const QString& channel, const QJsonValue& payload) { daemon.sendPush(channel, payload); }
    void pushCard(const QJsonObject& card) { push(QStringLiteral("agent:events"), QJsonObject{{"type", "card"}, {"card", card}}); }
    QList<QJsonObject> requests(const QString& channel) const { return daemon.requests(channel); }
    QString lastNotice() const
    {
        const Conversation* c = shell->conversation();
        return c->rowCount() ? c->get(c->rowCount() - 1).value(QStringLiteral("text")).toString() : QString();
    }
};
