import QtQuick
import QtTest
import Jarvis.UI
import Jarvis.Installer

TestCase {
    id: testCase
    name: "BrainScreen"
    when: windowShown
    visible: true
    width: 900
    height: 1000

    Component { id: screenComponent; BrainScreen {} }

    function make() {
        const m = harness.fresh()
        tryCompare(m, "probed", true)
        const s = createTemporaryObject(screenComponent, testCase, { installer: m, width: 780 })
        waitForRendering(s)
        return { m: m, s: s }
    }

    function test_factsAndRecommendedLocalModel() {
        const c = make()
        compare(findChild(c.s, "screenTitle").text, "Jarvis's brain")
        compare(findChild(c.s, "fact_Memory").text, "16 GB")
        compare(findChild(c.s, "fact_GPU").text, "NVIDIA GeForce RTX 3060 · 6 GB")
        compare(findChild(c.s, "fact_Free disk").text, "147 GB")
        const local = findChild(c.s, "kind_local")
        verify(local.selected)
        compare(local.title, "This computer — Qwen3 8B")
        compare(local.badge, "Recommended")
    }

    function test_otherModelsThatFitCanBePicked() {
        const c = make()
        verify(findChild(c.s, "modelList").visible)
        mouseClick(findChild(c.s, "model_qwen3-4b"))
        compare(c.m.brain.modelId, "qwen3-4b")
        compare(findChild(c.s, "kind_local").title, "This computer — Qwen3 4B")
    }

    function test_cloudAndLan() {
        const c = make()
        mouseClick(findChild(c.s, "kind_cloud"))
        compare(c.m.brain.kind, "cloud")
        verify(!findChild(c.s, "modelList").visible)
        mouseClick(findChild(c.s, "kind_lan"))
        verify(findChild(c.s, "lanUrl").visible)
        findChild(c.s, "lanUrl").input.forceActiveFocus()
        for (const ch of "http://10.0.0.2:11434") keyClick(ch)
        findChild(c.s, "lanModel").input.forceActiveFocus()
        for (const ch of "qwen3:14b") keyClick(ch)
        verify(c.m.brain.valid)
    }

    function test_noBackupModelLineInM2() {
        const c = make()
        const foot = findChild(c.s, "footNote")
        compare(foot.text, "You can add a cloud provider later, too.")
        verify(foot.text.indexOf("backup") < 0)
    }
}
