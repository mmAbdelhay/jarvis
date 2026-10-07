import QtQuick
import QtTest
import Jarvis.Shell

TestCase {
    id: testCase
    name: "ConfirmCard"
    when: windowShown
    visible: true
    width: 760
    height: 760

    Component { id: modelComponent; CardModel {} }
    Component { id: viewComponent; ConfirmCard {} }
    Component { id: spyComponent; SignalSpy {} }

    readonly property var installItems: [
        { itemId: "vlc", tool: "pkg.install", title: "Install VLC 3.0.21", detail: "Media player · 45 MB", source: "debian", risk: "confirm", secretFields: [] },
        { itemId: "gimp", tool: "pkg.install", title: "Install GIMP 3.0.4", detail: "Image editor · 128 MB", source: "debian", risk: "confirm", secretFields: [] },
        { itemId: "spotify", tool: "pkg.install", title: "Install Spotify", detail: "Not in Debian · 312 MB with runtime", source: "flathub", risk: "confirm", secretFields: [] }
    ]
    function wifiItem(id) {
        return { itemId: id, tool: "net.wifi_connect", title: "Connect to " + id, detail: "WPA2", source: "network", risk: "confirm",
                 secretFields: [{ name: "password", label: "Wi-Fi password" }] }
    }

    function makeCard(items) {
        const model = createTemporaryObject(modelComponent, testCase)
        model.setClockForTest(1000)
        verify(model.load({ cardId: "c1", turnId: "t1", expiresAt: 1000 + 300000, items: items }))
        const view = createTemporaryObject(viewComponent, testCase, { card: model, width: 720 })
        verify(view)
        waitForRendering(view)
        return { model: model, view: view }
    }

    function test_everyItemTickedByDefault() {
        const c = makeCard(installItems)
        compare(c.model.tickedCount, 3)
        verify(findChild(c.view, "tick_vlc").checked)
        compare(findChild(c.view, "approveButton").text, "Approve all 3")
        compare(c.view.card.headline, "Jarvis wants to do 3 things")
    }

    function test_untickingOneApprovesTheRest() {
        const c = makeCard(installItems)
        mouseClick(findChild(c.view, "tick_gimp"))
        compare(c.model.tickedCount, 2)
        verify(!findChild(c.view, "tick_gimp").checked)
        compare(findChild(c.view, "approveButton").text, "Approve 2 of 3")
        const spy = createTemporaryObject(spyComponent, testCase, { target: c.view, signalName: "decided" })
        mouseClick(findChild(c.view, "approveButton"))
        compare(spy.count, 1)
        compare(spy.signalArguments[0][0], true)
        compare(c.model.decision(true).ticked, ["vlc", "spotify"])
    }

    function test_nothingTickedDisablesApprove() {
        const c = makeCard(installItems)
        mouseClick(findChild(c.view, "tick_vlc"))
        mouseClick(findChild(c.view, "tick_gimp"))
        mouseClick(findChild(c.view, "tick_spotify"))
        verify(!findChild(c.view, "approveButton").enabled)
    }

    function test_denyHasFocusAndSpaceDenies() {
        const c = makeCard(installItems)
        const deny = findChild(c.view, "denyButton")
        tryVerify(() => deny.activeFocus)
        const spy = createTemporaryObject(spyComponent, testCase, { target: c.view, signalName: "decided" })
        keyClick(Qt.Key_Space)
        compare(spy.count, 1)
        compare(spy.signalArguments[0][0], false)
    }

    function test_secretFieldIsMaskedAndOnlySentWhenTicked() {
        const c = makeCard([wifiItem("home")])
        verify(findChild(c.view, "secret_home_password") === null) // pick-one card: nothing ticked yet (§6.9)
        mouseClick(findChild(c.view, "tick_home"))
        tryVerify(() => findChild(c.view, "secret_home_password") !== null)
        const secret = findChild(c.view, "secret_home_password")
        const input = secret.field
        compare(input.echoMode, TextInput.Password)
        input.forceActiveFocus()
        for (const ch of "hunter2")
            keyClick(ch)
        compare(input.text, "hunter2")
        verify(input.displayText.indexOf("hunter") === -1)
        compare(c.model.decision(true).secrets, { home: { password: "hunter2" } })
        compare(c.model.decision(false).secrets, {})
        wait(600) // keep the second click from being read as a double click
        mouseClick(findChild(c.view, "tick_home"))
        tryVerify(() => findChild(c.view, "secret_home_password") === null)
        compare(c.model.decision(true).approve, false)
    }

    function test_countdownAndTimeout() {
        const c = makeCard(installItems)
        compare(findChild(c.view, "countdown").text, "Auto-deny in 5:00")
        c.model.setClockForTest(1000 + 8000)
        compare(findChild(c.view, "countdown").text, "Auto-deny in 4:52")
        c.model.setClockForTest(1000 + 300000)
        compare(findChild(c.view, "countdown").text, "Timed out")
        verify(!findChild(c.view, "approveButton").enabled)
    }

    function test_wifiNetworksArePickOne() {
        const c = makeCard([wifiItem("a"), wifiItem("b")])
        verify(c.model.exclusive)
        compare(findChild(c.view, "approveButton").text, "Connect")
        compare(findChild(c.view, "denyButton").text, "Cancel")
        verify(!findChild(c.view, "approveButton").enabled)
        mouseClick(findChild(c.view, "tick_a"))
        mouseClick(findChild(c.view, "tick_b"))
        verify(!findChild(c.view, "tick_a").checked)
        verify(findChild(c.view, "tick_b").checked)
        compare(c.model.decision(true).ticked, ["b"])
    }

    // Contracts §6.1: one card item per app, each with its own source.
    function test_perAppItemsShowTheirOwnSource() {
        const c = makeCard(installItems)
        compare(c.model.itemCount, 3)
        compare(findChild(c.view, "source_vlc").text, "Debian")
        compare(findChild(c.view, "source_spotify").text, "Flathub")
        mouseClick(findChild(c.view, "tick_gimp"))
        const spy = createTemporaryObject(spyComponent, testCase, { target: c.view, signalName: "decided" })
        mouseClick(findChild(c.view, "approveButton"))
        compare(spy.signalArguments[0][0], true)
        const d = c.model.decision(true)
        compare(d.ticked.length, 2)
        compare(d.ticked, ["vlc", "spotify"])
    }

    function test_titlesRenderAsPlainText() {
        const c = makeCard([{ itemId: "x", tool: "pkg.install", title: "<b>Install</b> <a href='http://evil'>me</a>",
                              detail: "<img src='http://evil/x.png'>", source: "debian", risk: "confirm", secretFields: [] }])
        const title = findChild(c.view, "title_x")
        compare(title.textFormat, Text.PlainText)
        compare(title.text, "<b>Install</b> <a href='http://evil'>me</a>")
        compare(findChild(c.view, "detail_x").textFormat, Text.PlainText)
    }
}
