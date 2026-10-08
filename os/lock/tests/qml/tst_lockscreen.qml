import QtQuick
import QtTest
import Jarvis.UI
import Jarvis.Lock

TestCase {
    id: testCase
    name: "LockScreen"
    when: windowShown
    visible: true
    width: 1200
    height: 800

    Component { id: screenComponent; LockScreen { width: 1200; height: 800 } }

    function typeText(text) {
        for (const ch of text)
            keyClick(ch)
    }

    function test_secondaryScreenHasNoPasswordField() {
        const s = createTemporaryObject(screenComponent, testCase, { lock: testLock, primary: false })
        waitForRendering(s)
        verify(!findChild(s, "passwordPanel").visible)
        verify(findChild(s, "clock").visible)
        verify(findChild(s, "lockedLabel").visible)
    }

    function test_unlockFlow() {
        const s = createTemporaryObject(screenComponent, testCase, { lock: testLock, primary: true })
        waitForRendering(s)
        const field = findChild(s, "passwordField")
        tryVerify(() => field.activeFocus)
        compare(findChild(s, "avatarInitial").text, "M")
        compare(findChild(s, "name").text, "Muhammad AbdElHay")
        typeText("wrong")
        keyClick(Qt.Key_Return)
        compare(testLock.state, "checking")
        compare(testAuth.secretSeen(), "wrong")
        compare(field.text, "")
        verify(!field.enabled)
        testAuth.resolve(false, "")
        compare(testLock.state, "ready")
        verify(findChild(s, "errorText").text.indexOf("didn't work") >= 0)
        tryVerify(() => field.activeFocus)
        typeText("right")
        keyClick(Qt.Key_Return)
        testAuth.resolve(true, "")
        compare(testLock.state, "unlocking")
    }
}
