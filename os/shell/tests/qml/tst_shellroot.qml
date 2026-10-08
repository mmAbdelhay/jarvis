import QtQuick
import Jarvis.UI
import QtTest
import Jarvis.Shell

TestCase {
    id: testCase
    name: "ShellRoot"
    when: windowShown
    visible: true
    width: 1440
    height: 900

    Component { id: rootComponent; ShellRoot {} }
    Component { id: spyComponent; SignalSpy {} }
    Component { id: bannerComponent; Banner {} }

    function makeRoot() {
        const root = createTemporaryObject(rootComponent, testCase, { shell: testShell, width: 1440, height: 900 })
        waitForRendering(root)
        return root
    }

    function test_connectingState() {
        // testShell's client is never started, so it stays "connecting" in every test.
        const root = makeRoot()
        compare(testShell.connection, "connecting")
        compare(findChild(root, "loadingText").text, "Connecting to Jarvis…")
        compare(findChild(root, "bannerText").text, "Connecting to Jarvis…")
        verify(!findChild(root, "bannerDoctor").visible)
        verify(!findChild(root, "bannerClassic").visible) // no classic switcher in tests
    }

    // M4 contracts §6.14: the jarvisd-down banner's way out.
    function test_bannerOffersClassic() {
        const banner = createTemporaryObject(bannerComponent, testCase, { width: 1000, text: "x", showClassic: true })
        waitForRendering(banner)
        const button = findChild(banner, "bannerClassic")
        verify(button.visible)
        compare(button.text, "Switch to classic")
        const spy = createTemporaryObject(spyComponent, testCase, { target: banner, signalName: "classicRequested" })
        mouseClick(button)
        compare(spy.count, 1)
    }

    function test_navigationAndEscape() {
        const root = makeRoot()
        mouseClick(findChild(root, "navAudit"))
        compare(testShell.view, "audit")
        compare(findChild(root, "views").currentIndex, 4)
        verify(findChild(root, "navAudit").selected)
        keyClick(Qt.Key_Escape)
        compare(testShell.view, "chat")
        compare(findChild(root, "views").currentIndex, 2)
        verify(findChild(root, "machinePanel").visible)
        mouseClick(findChild(root, "navSettings"))
        compare(testShell.view, "settings")
        keyClick(Qt.Key_Escape)
        compare(testShell.view, "chat")
    }

    function test_escapeInChatDismisses() {
        const root = makeRoot()
        testShell.showView("chat")
        const spy = createTemporaryObject(spyComponent, testCase, { target: testShell, signalName: "dismissRequested" })
        keyClick(Qt.Key_Escape)
        compare(spy.count, 1)
    }

    function test_terminalShortcutAndButton() {
        const root = makeRoot()
        testShell.showView("chat")
        const spy = createTemporaryObject(spyComponent, testCase, { target: testShell, signalName: "dismissRequested" })
        keyClick(Qt.Key_T, Qt.ControlModifier | Qt.AltModifier)
        compare(spy.count, 1)
        mouseClick(findChild(root, "navTerminal"))
        compare(spy.count, 2)
    }

    function test_machinePanelShowsTheSnapshot() {
        const root = makeRoot()
        testShell.showView("chat")
        const gib = 1024 * 1024 * 1024
        testShell.system.applySnapshot({ online: false, network: { connectivity: "none", wifiSsid: null },
                                         memTotalBytes: 16 * gib, memUsedBytes: 3.1 * gib,
                                         disk: { mount: "/", sizeBytes: 186 * gib, usedBytes: 71 * gib },
                                         failedUnits: ["NetworkManager.service"],
                                         model: { kind: "ollama", model: "qwen3:8b", local: true, supportsTools: true } })
        const value = (row) => findChild(findChild(root, row), "value").text
        compare(value("panelNetwork"), "Offline")
        compare(value("panelModel"), "qwen3:8b")
        compare(value("panelMemory"), "3.1 / 16 GB")
        compare(value("panelDisk"), "71 / 186 GB")
        compare(value("panelFailed"), "1")
        compare(findChild(root, "reachText").text, "Offline")
        // Offline alone does not offer the doctor: the provider must be unreachable too,
        // and this test controller is not even connected.
        verify(!findChild(root, "bannerDoctor").visible)
        testShell.system.reset()
    }

    function test_activityLinkOpensTheLog() {
        const root = makeRoot()
        testShell.showView("chat")
        mouseClick(findChild(root, "openActivityLog"))
        compare(testShell.view, "audit")
        testShell.showView("chat")
    }
}
