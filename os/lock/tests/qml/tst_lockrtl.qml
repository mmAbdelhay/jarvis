import QtQuick
import QtTest
import Jarvis.Lock

TestCase {
    name: "LockRtl"
    when: windowShown
    visible: true
    width: 1280
    height: 800

    Component { id: screen; LockScreen { width: 1280; height: 800; primary: true } }

    function cleanup() { testLanguage.setLanguage("en") }

    function test_arabicLockScreen() {
        verify(testLanguage.setLanguage("ar"))
        const s = createTemporaryObject(screen, this, { lock: testLock })
        compare(findChild(s, "lockedLabel").text, "مقفل")
        compare(findChild(s, "passwordField").placeholderText, "كلمة المرور")
        verify(s.LayoutMirroring.enabled)
    }
}
