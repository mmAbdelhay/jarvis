import QtQuick
import QtTest
import Jarvis.Shell

TestCase {
    id: testCase
    name: "ChatView"
    when: windowShown
    visible: true
    width: 1000
    height: 760

    Component { id: conversationComponent; Conversation {} }
    Component { id: cardComponent; CardModel {} }
    Component { id: viewComponent; ChatView {} }
    Component { id: spyComponent; SignalSpy {} }

    function makeView() {
        const conversation = createTemporaryObject(conversationComponent, testCase)
        const card = createTemporaryObject(cardComponent, testCase)
        const view = createTemporaryObject(viewComponent, testCase,
                                           { conversation: conversation, card: card, width: 1000, height: 760 })
        waitForRendering(view)
        return { conversation: conversation, card: card, view: view, list: findChild(view, "messages") }
    }

    function test_streamsTextIntoOneRow() {
        const c = makeView()
        c.conversation.applyEvent({ type: "turn-start", turnId: "t1", text: "what's using my disk?" })
        c.conversation.applyEvent({ type: "text", turnId: "t1", delta: "Your disk " })
        c.conversation.applyEvent({ type: "text", turnId: "t1", delta: "is 38% full." })
        compare(c.list.count, 2)
        tryVerify(() => c.list.itemAtIndex(1) !== null && c.list.itemAtIndex(1).item !== null)
        compare(c.list.itemAtIndex(1).item.text, "Your disk is 38% full.")
        compare(c.list.itemAtIndex(0).item.text, "what's using my disk?")
    }

    function test_toolLineUpdatesInPlace() {
        const c = makeView()
        c.conversation.applyEvent({ type: "turn-start", turnId: "t1", text: "my internet isn't working" })
        c.conversation.applyEvent({ type: "tool", turnId: "t1", callId: "c1", name: "net.status", status: "running", summary: "" })
        c.conversation.applyEvent({ type: "tool", turnId: "t1", callId: "c1", name: "net.status", status: "ok", summary: "wlp2s0 disconnected" })
        compare(c.list.count, 2)
        tryVerify(() => c.list.itemAtIndex(1) !== null && c.list.itemAtIndex(1).item !== null)
        compare(c.list.itemAtIndex(1).item.text, "wlp2s0 disconnected")
        compare(findChild(c.list.itemAtIndex(1).item, "toolGlyph").text, "✓")
    }

    function test_assistantTextIsPlain() {
        const c = makeView()
        c.conversation.applyEvent({ type: "turn-start", turnId: "t1", text: "q" })
        c.conversation.applyEvent({ type: "text", turnId: "t1", delta: "<b>bold</b> <a href='http://evil'>x</a>" })
        tryVerify(() => c.list.itemAtIndex(1) !== null && c.list.itemAtIndex(1).item !== null)
        const item = c.list.itemAtIndex(1).item
        compare(item.textFormat, TextEdit.PlainText)
        compare(item.text, "<b>bold</b> <a href='http://evil'>x</a>")
    }

    function test_composerSubmitsAndClears() {
        const c = makeView()
        const spy = createTemporaryObject(spyComponent, testCase, { target: c.view, signalName: "submit" })
        const field = findChild(c.view, "promptField")
        field.forceActiveFocus()
        for (const ch of "install vlc")
            keyClick(ch)
        keyClick(Qt.Key_Return)
        compare(spy.count, 1)
        compare(spy.signalArguments[0][0], "install vlc")
        compare(field.text, "")
    }

    function test_busyShowsStop() {
        const c = makeView()
        verify(findChild(c.view, "sendButton").visible)
        c.conversation.applyEvent({ type: "turn-start", turnId: "t1", text: "q" })
        const stop = findChild(c.view, "stopButton")
        tryVerify(() => stop.visible)
        const spy = createTemporaryObject(spyComponent, testCase, { target: c.view, signalName: "stopRequested" })
        mouseClick(stop)
        compare(spy.count, 1)
    }

    function test_cardAppearsBelowTheMessages() {
        const c = makeView()
        verify(!findChild(c.view, "chatCard").visible)
        c.card.setClockForTest(1000)
        verify(c.card.load({ cardId: "c1", turnId: "t1", expiresAt: 301000, items: [
            { itemId: "nm", tool: "svc.restart", title: "Restart NetworkManager", detail: "", source: "system", risk: "confirm", secretFields: [] }] }))
        tryVerify(() => findChild(c.view, "chatCard").visible)
        const spy = createTemporaryObject(spyComponent, testCase, { target: c.view, signalName: "decided" })
        mouseClick(findChild(c.view, "approveButton"))
        compare(spy.signalArguments[0][0], true)
    }
}
