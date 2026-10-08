import QtQuick
import QtTest
import Jarvis.UI
import Jarvis.Shell

TestCase {
    id: testCase
    name: "PairingCard"
    when: windowShown
    visible: true
    width: 800
    height: 400

    Component { id: cardComponent; PairingCard { width: 760 } }

    function cleanup() { testShell.pairing.deny() }

    function test_rendersPlainAndFocusesDeny() {
        verify(testShell.pairing.load({ requestId: "r1", deviceName: "<b>Pixel</b>", address: "192.168.1.5" }))
        const c = createTemporaryObject(cardComponent, testCase, { pairing: testShell.pairing })
        waitForRendering(c)
        verify(c.visible)
        const device = findChild(c, "pairingDevice")
        verify(device.text.indexOf("<b>Pixel</b>") >= 0)
        compare(device.textFormat, Text.PlainText)
        compare(findChild(c, "pairingAddress").text, "Address: 192.168.1.5")
        tryVerify(() => findChild(c, "pairingDeny").activeFocus)
    }
}
