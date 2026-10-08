import QtQuick
import QtTest
import Jarvis.Classic

TestCase {
    name: "Taskbar"
    when: windowShown
    visible: true
    width: 1280
    height: 60

    Component { id: bar; Taskbar { width: 1280; controller: testController } }

    function cleanup() {
        testLanguage.setLanguage("en")
        testController.closeApps()
        testController.closeChat()
    }

    function test_buttonsStartTheirPrograms() {
        const b = createTemporaryObject(bar, this)
        mouseClick(findChild(b, "terminalButton"))
        mouseClick(findChild(b, "filesButton"))
        mouseClick(findChild(b, "settingsButton"))
        compare(testStarts.all.slice(-3), ["foot", "pcmanfm-qt", "jarvis-shell --settings"])
    }

    function test_appsAndJarvisToggle() {
        const b = createTemporaryObject(bar, this)
        mouseClick(findChild(b, "appsButton"))
        verify(testController.appsOpen)
        mouseClick(findChild(b, "jarvisButton"))
        verify(testController.chatOpen)
        mouseClick(findChild(b, "jarvisButton"))
        verify(!testController.chatOpen)
    }

    function test_statusWithoutJarvis() {
        const b = createTemporaryObject(bar, this)
        compare(findChild(b, "networkText").text, "Network unknown")
        verify(findChild(b, "classicNote").visible) // the test controller is a fallback session
        verify(findChild(b, "clock").text.match(/^\d\d:\d\d$/))
    }

    function test_arabicMirrorsAndTranslates() {
        verify(testLanguage.setLanguage("ar"))
        const b = createTemporaryObject(bar, this)
        compare(findChild(b, "appsButton").text, "التطبيقات")
        compare(findChild(b, "jarvisButton").text, "جارفيس")
        compare(findChild(b, "networkText").text, "حالة الشبكة غير معروفة")
        verify(findChild(b, "appsButton").mapToItem(b, 0, 0).x > b.width / 2)
        verify(findChild(b, "jarvisButton").mapToItem(b, 0, 0).x < b.width / 2)
    }
}
