import QtQuick
import Jarvis.UI
import QtTest
import Jarvis.Shell

TestCase {
    id: testCase
    name: "UpdatesAndDownload"
    when: windowShown
    visible: true
    width: 1440
    height: 900

    Component { id: rootComponent; ShellRoot {} }

    function cleanup() { testShell.system.reset() }
    function make() {
        const root = createTemporaryObject(rootComponent, testCase, { shell: testShell, width: 1440, height: 900 })
        testShell.showView("chat")
        waitForRendering(root)
        return root
    }
    function snap(updates, download) {
        testShell.system.applySnapshot({ online: true, network: { connectivity: "full", wifiSsid: null },
                                         memTotalBytes: 0, memUsedBytes: 0, disk: { mount: "/", sizeBytes: 0, usedBytes: 0 },
                                         failedUnits: [], updates: updates,
                                         model: { kind: "ollama", model: "qwen3:8b", local: true, supportsTools: true, download: download } })
    }

    function test_badgeAppearsWithUpdates() {
        const root = make()
        verify(!findChild(root, "updatesBadge").visible)
        snap({ count: 3, security: 1, checkedAt: null }, null)
        verify(findChild(root, "updatesBadge").visible)
        compare(findChild(root, "updatesText").text, "3 updates · 1 security")
        testShell.showView("audit")
        mouseClick(findChild(root, "updatesBadge"))
        compare(testShell.view, "chat")
    }

    function test_modelDownloadInThePanel() {
        const root = make()
        snap({ count: 0, security: 0, checkedAt: null }, { state: "downloading", percent: 42 })
        const model = findChild(root, "panelModel")
        compare(model.fraction, 0.42)
        compare(model.detail, "Downloading · 42%")
        snap({ count: 0, security: 0, checkedAt: null }, { state: "ready", percent: 100 })
        compare(model.fraction, -1)
    }
}
