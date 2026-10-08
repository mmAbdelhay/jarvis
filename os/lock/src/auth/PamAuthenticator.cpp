#include "auth/PamAuthenticator.h"

#include <security/pam_appl.h>

#include <cstdlib>
#include <cstring>
#include <memory>

#include "auth/Wipe.h"

namespace {
struct Conversation {
    QByteArray secret;
    QStringList messages;
    int secretPrompts = 0;
};

struct Result {
    bool ok = false;
    QString message;
};

void freeReplies(pam_response* replies, int count)
{
    for (int i = 0; i < count; ++i) {
        if (replies[i].resp) {
            jarvis::lock::wipe(replies[i].resp, std::strlen(replies[i].resp));
            std::free(replies[i].resp);
        }
    }
    std::free(replies);
}

int converse(int count, const pam_message** messages, pam_response** out, void* data)
{
    if (count <= 0 || count > PAM_MAX_NUM_MSG)
        return PAM_CONV_ERR;
    auto* conv = static_cast<Conversation*>(data);
    auto* replies = static_cast<pam_response*>(std::calloc(size_t(count), sizeof(pam_response)));
    if (!replies)
        return PAM_BUF_ERR;
    for (int i = 0; i < count; ++i) {
        switch (messages[i]->msg_style) {
        case PAM_PROMPT_ECHO_OFF: {
            if (conv->secretPrompts++ > 0) { // one password per attempt
                freeReplies(replies, count);
                return PAM_CONV_ERR;
            }
            const size_t size = size_t(conv->secret.size());
            replies[i].resp = static_cast<char*>(std::malloc(size + 1));
            if (!replies[i].resp) {
                freeReplies(replies, count);
                return PAM_BUF_ERR;
            }
            std::memcpy(replies[i].resp, conv->secret.constData(), size);
            replies[i].resp[size] = '\0';
            break;
        }
        case PAM_ERROR_MSG:
        case PAM_TEXT_INFO:
            if (messages[i]->msg)
                conv->messages.append(QString::fromUtf8(messages[i]->msg).simplified().left(160));
            break;
        default: // PAM_PROMPT_ECHO_ON (a user name, an OTP): not on a lock screen
            freeReplies(replies, count);
            return PAM_CONV_ERR;
        }
    }
    *out = replies;
    return PAM_SUCCESS;
}

bool check(const QByteArray& service, const QByteArray& user, Conversation& conv)
{
    const pam_conv pc{converse, &conv};
    pam_handle_t* handle = nullptr;
    int rc = pam_start(service.constData(), user.constData(), &pc, &handle);
    if (rc != PAM_SUCCESS)
        return false;
    rc = pam_authenticate(handle, PAM_DISALLOW_NULL_AUTHTOK);
    if (rc == PAM_SUCCESS) {
        rc = pam_acct_mgmt(handle, PAM_DISALLOW_NULL_AUTHTOK);
        if (rc == PAM_NEW_AUTHTOK_REQD)
            rc = PAM_SUCCESS;
    }
    if (rc == PAM_SUCCESS)
        pam_setcred(handle, PAM_REFRESH_CRED);
    pam_end(handle, rc);
    return rc == PAM_SUCCESS;
}
} // namespace

PamAuthenticator::PamAuthenticator(QByteArray service, QObject* parent)
    : Authenticator(parent)
    , m_service(std::move(service))
{
}

PamAuthenticator::~PamAuthenticator()
{
    if (m_worker)
        m_worker->wait();
}

void PamAuthenticator::start(const QString& user, QByteArray secret)
{
    auto result = std::make_shared<Result>();
    QThread* worker = QThread::create(
        [result, service = m_service, login = user.toUtf8(), secret = std::move(secret)]() mutable {
            Conversation conv;
            conv.secret = std::move(secret);
            result->ok = check(service, login, conv);
            jarvis::lock::wipe(conv.secret);
            if (!result->ok && !conv.messages.isEmpty())
                result->message = conv.messages.constLast();
        });
    m_worker = worker;
    connect(worker, &QThread::finished, this, [this, worker, result] {
        worker->deleteLater();
        if (m_worker == worker)
            m_worker.clear();
        emit finished(result->ok, result->message);
    });
    worker->start();
}
