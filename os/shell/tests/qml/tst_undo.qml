import QtQuick
import QtTest
import Jarvis.UI
import Jarvis.Shell

TestCase {
    id: testCase
    name: "Undo"
    when: windowShown
    visible: true
    width: 800
    height: 200

    Component { id: composerComponent; Composer { width: 760 } }
    Component { id: spyComponent; SignalSpy {} }

    function test_undoButton() {
        const c = createTemporaryObject(composerComponent, testCase, { undoAvailable: false })
        const button = findChild(c, "undoButton")
        verify(!button.visible)
        c.undoAvailable = true
        verify(button.visible)
        const spy = createTemporaryObject(spyComponent, testCase, { target: c, signalName: "undoRequested" })
        mouseClick(button)
        compare(spy.count, 1)
        c.busy = true
        verify(!button.visible)
    }
}
