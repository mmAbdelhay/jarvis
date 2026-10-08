import QtQuick
import QtTest
import Jarvis.UI
import Jarvis.Shell

TestCase {
    id: testCase
    name: "LockedCard"
    when: windowShown
    visible: true
    width: 760
    height: 500

    Component { id: modelComponent; CardModel {} }
    Component { id: viewComponent; ConfirmCard {} }

    function test_lockedCardCannotBeAnswered() {
        const model = createTemporaryObject(modelComponent, testCase)
        model.setClockForTest(1000)
        verify(model.load({ cardId: "c1", turnId: "t1", expiresAt: 301000, items: [
            { itemId: "a", tool: "settings.volume", title: "Volume", detail: "30% → 60%", source: "system", risk: "confirm", secretFields: [] }] }))
        const view = createTemporaryObject(viewComponent, testCase, { card: model, width: 720 })
        waitForRendering(view)
        verify(findChild(view, "approveButton").enabled)
        model.locked = true
        verify(!findChild(view, "approveButton").enabled)
        verify(!findChild(view, "denyButton").enabled)
        verify(findChild(view, "cardHint").text.indexOf("locked") >= 0)
        model.locked = false
        verify(findChild(view, "denyButton").enabled)
    }
}
