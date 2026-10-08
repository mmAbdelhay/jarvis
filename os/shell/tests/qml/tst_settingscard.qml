import QtQuick
import QtTest
import Jarvis.UI
import Jarvis.Shell

TestCase {
    id: testCase
    name: "SettingsCard"
    when: windowShown
    visible: true
    width: 760
    height: 600

    Component { id: modelComponent; CardModel {} }
    Component { id: viewComponent; ConfirmCard {} }
    Component { id: conversationComponent; Conversation {} }
    Component { id: chatComponent; ChatView {} }

    function test_toolSummaryUpdatesToChange() {
        const model = createTemporaryObject(modelComponent, testCase)
        const conversation = createTemporaryObject(conversationComponent, testCase)
        conversation.applyEvent({ type: "tool", turnId: "t1", callId: "k1", name: "settings.brightness", status: "running", summary: "Setting brightness" })
        const view = createTemporaryObject(chatComponent, testCase, { card: model, conversation: conversation, width: 720, height: 600 })
        waitForRendering(view)
        const change = findChild(view, "toolChange")
        verify(change !== null)
        verify(!change.visible)
        conversation.applyEvent({ type: "tool", turnId: "t1", callId: "k1", name: "settings.brightness", status: "ok", summary: "<b>40%</b> → 70%" })
        tryCompare(change, "visible", true)
        compare(change.from, "<b>40%</b>")
        compare(change.to, "70%")
        conversation.applyEvent({ type: "tool", turnId: "t1", callId: "k1", name: "settings.brightness", status: "error", summary: "Could not change brightness" })
        tryCompare(change, "visible", false)
    }

    function test_changeRowReplacesTheDetail() {
        const model = createTemporaryObject(modelComponent, testCase)
        model.setClockForTest(1000)
        verify(model.load({ cardId: "c1", turnId: "t1", expiresAt: 301000, items: [
            { itemId: "b", tool: "settings.brightness", title: "Screen brightness", detail: "<b>40%</b> → 70%", source: "system", risk: "confirm", secretFields: [] },
            { itemId: "w", tool: "settings.wifi", title: "Turn Wi-Fi off", detail: "You will go offline", source: "system", risk: "confirm", secretFields: [] }
        ] }))
        const view = createTemporaryObject(viewComponent, testCase, { card: model, width: 720 })
        waitForRendering(view)
        const change = findChild(view, "change_b")
        verify(change.visible)
        compare(change.from, "<b>40%</b>")
        compare(change.to, "70%")
        verify(!findChild(view, "detail_b").visible)
        verify(!findChild(view, "change_w").visible)
        verify(findChild(view, "detail_w").visible)
    }
}
