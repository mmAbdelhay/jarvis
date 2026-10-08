import QtQuick
import QtTest
import Jarvis.UI
import Jarvis.Shell

TestCase {
    id: testCase
    name: "PhoneSection"
    when: windowShown
    visible: true
    width: 900
    height: 800

    Component { id: phoneComponent; PhoneModel {} }
    Component { id: sectionComponent; PhoneSection { width: 860 } }
    Component { id: spyComponent; SignalSpy {} }

    function status(enabled, pairing) {
        return {
            enabled: enabled,
            listening: enabled ? { host: "192.168.1.20", port: 8765, fingerprint: "ab:cd" } : null,
            pairing: pairing || "closed",
            devices: [{ id: "dev-1", name: "Pixel <b>8</b>", connected: true, lastSeenAt: null }],
            hasOwnerPassword: true,
            problem: null
        }
    }

    function makeSection(st) {
        const phone = createTemporaryObject(phoneComponent, testCase)
        if (st)
            phone.applyStatus(st)
        const section = createTemporaryObject(sectionComponent, testCase, { phone: phone })
        waitForRendering(section)
        return { phone: phone, section: section }
    }

    function test_offShowsNoPairingOrDevices() {
        const c = makeSection(status(false))
        verify(!findChild(c.section, "phoneEnabled").checked)
        verify(!findChild(c.section, "phonePair").visible)
        verify(!findChild(c.section, "phoneDevice_dev-1").visible)
    }

    function test_toggleSendsConfigure() {
        const c = makeSection(status(false))
        const spy = createTemporaryObject(spyComponent, testCase, { target: c.phone, signalName: "configureRequested" })
        mouseClick(findChild(c.section, "phoneEnabled"))
        compare(spy.count, 1)
        compare(spy.signalArguments[0][0], true)
    }

    function test_onShowsAddressAndDevicesAsPlainText() {
        const c = makeSection(status(true))
        compare(findChild(c.section, "phoneAddress").text.indexOf("192.168.1.20:8765") >= 0, true)
        const name = findChild(c.section, "phoneDeviceName_dev-1")
        compare(name.text, "Pixel <b>8</b>")
        compare(name.textFormat, Text.PlainText)
    }

    function test_revokeSendsTheId() {
        const c = makeSection(status(true))
        const spy = createTemporaryObject(spyComponent, testCase, { target: c.phone, signalName: "revokeRequested" })
        mouseClick(findChild(c.section, "phoneRevoke_dev-1"))
        compare(spy.count, 1)
        compare(spy.signalArguments[0][0], "dev-1")
    }

    function test_pairShowsUriAndCancel() {
        const c = makeSection(status(true))
        const opens = createTemporaryObject(spyComponent, testCase, { target: c.phone, signalName: "pairingOpenRequested" })
        mouseClick(findChild(c.section, "phonePair"))
        compare(opens.count, 1)
        c.phone.applyPairingOpened({ uri: "jarvis://pair?t=abc", expiresAt: 1 })
        waitForRendering(c.section)
        compare(findChild(c.section, "phonePairingUri").text, "jarvis://pair?t=abc")
        const cancels = createTemporaryObject(spyComponent, testCase, { target: c.phone, signalName: "pairingCancelRequested" })
        mouseClick(findChild(c.section, "phonePairCancel"))
        compare(cancels.count, 1)
    }

    function test_ownerPasswordClearsFieldsAfterSave() {
        const c = makeSection(status(true))
        const spy = createTemporaryObject(spyComponent, testCase, { target: c.phone, signalName: "ownerPasswordRequested" })
        const current = findChild(findChild(c.section, "phoneCurrentPassword"), "input")
        const next = findChild(findChild(c.section, "phoneNewPassword"), "input")
        current.text = "old"
        next.text = "new-secret"
        mouseClick(findChild(c.section, "phoneSavePassword"))
        compare(spy.count, 1)
        compare(spy.signalArguments[0][0], "old")
        compare(spy.signalArguments[0][1], "new-secret")
        compare(current.text, "")
        compare(next.text, "")
    }
}
