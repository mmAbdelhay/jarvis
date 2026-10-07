#include "protocol/Handshake.h"

#include <QMessageAuthenticationCode>

namespace jarvis::protocol {
namespace {

QByteArray proof(const QByteArray& secret, QByteArrayView label, const QByteArray& first,
                 const QByteArray& second)
{
    QMessageAuthenticationCode mac(QCryptographicHash::Sha256, secret);
    mac.addData(label);
    mac.addData(first);
    mac.addData(second);
    return mac.result();
}

} // namespace

QByteArray serverProof(const QByteArray& secret, const QByteArray& nonceC, const QByteArray& nonceS)
{
    return proof(secret, "jarvisd-server", nonceC, nonceS);
}

QByteArray clientProof(const QByteArray& secret, const QByteArray& nonceS, const QByteArray& nonceC)
{
    return proof(secret, "jarvisd-client", nonceS, nonceC);
}

bool isHex32(QStringView text)
{
    if (text.size() != 2 * kNonceBytes)
        return false;
    for (const QChar c : text) {
        const char16_t u = c.unicode();
        if (!((u >= u'0' && u <= u'9') || (u >= u'a' && u <= u'f')))
            return false;
    }
    return true;
}

bool proofMatches(const QByteArray& expected, QStringView givenHex)
{
    if (!isHex32(givenHex) || expected.size() != kNonceBytes)
        return false;
    const QByteArray given = QByteArray::fromHex(givenHex.toLatin1());
    unsigned char difference = 0;
    for (int i = 0; i < kNonceBytes; ++i)
        difference |= uchar(expected[i]) ^ uchar(given[i]);
    return difference == 0;
}

std::optional<QByteArray> parseSecret(const QByteArray& fileContent)
{
    const QByteArray trimmed = fileContent.trimmed();
    if (!isHex32(QString::fromLatin1(trimmed)))
        return std::nullopt;
    return QByteArray::fromHex(trimmed);
}

} // namespace jarvis::protocol
