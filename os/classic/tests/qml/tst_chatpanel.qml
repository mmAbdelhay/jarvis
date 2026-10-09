import QtQuick
import QtTest
import Jarvis.Classic

TestCase {
    name: "ChatPanel"
    when: windowShown
    visible: true
    width: 420
    height: 800

    Component { id: panel; ChatPanel { width: 420; height: 800; controller: testController } }

    function cleanup() {
        testLanguage.setLanguage("en")
        testController.closeChat()
    }

    function test_withoutJarvisSaysSoAndHidesTheChat() {
        const p = createTemporaryObject(panel, this)
        verify(findChild(p, "chatUnavailable").visible)
        verify(!findChild(p, "classicChat").visible)
    }

    function test_closeButtonClosesThePanel() {
        testController.openChat()
        const p = createTemporaryObject(panel, this)
        mouseClick(findChild(p, "closeChat"))
        verify(!testController.chatOpen)
    }

    function test_arabic() {
        verify(testLanguage.setLanguage("ar"))
        const p = createTemporaryObject(panel, this)
        compare(findChild(p, "chatUnavailable").text, "جارفيس لا يعمل حاليًا. ما زالت التطبيقات والطرفية والملفات تعمل.")
        verify(p.LayoutMirroring.enabled)
    }
}
