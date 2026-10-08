import QtQuick
import QtTest
import Jarvis.UI
import Jarvis.Shell

TestCase {
    id: testCase
    name: "ToolsSection"
    when: windowShown
    visible: true
    width: 900
    height: 900

    property var sections: []

    function cleanup() {
        for (const section of sections)
            section.destroy()
        sections = []
        wait(0)
    }

    Component { id: registryComponent; RegistryModel {} }
    Component { id: sectionComponent; ToolsSection { width: 860 } }
    Component { id: spyComponent; SignalSpy {} }

    function entry(id, version, tier, network) {
        return { id: id, name: id === "weather" ? "<i>Weather</i>" : id, description: "Does " + id, tier: tier, version: version,
                 artifact: { url: "https://example.invalid/" + id, sha256: "a".repeat(64), runtime: "go-static" },
                 permissions: { network: network, paths: [] }, tools: [{ name: id + ".run", risk: "safe" }] }
    }

    function makeSection() {
        const registry = createTemporaryObject(registryComponent, testCase)
        registry.applyList({ installed: [entry("jarvis-clock", "1.0.0", "official", false)],
                             available: [entry("jarvis-clock", "1.0.0", "official", false),
                                         entry("jarvis-web", "1.0.0", "official", true),
                                         entry("weather", "0.3", "community", true)] })
        const section = createTemporaryObject(sectionComponent, testCase, { registry: registry })
        sections.push(section)
        waitForRendering(section)
        return { registry: registry, section: section }
    }

    function test_installedShowsRemoveAndAvailableShowsInstall() {
        const c = makeSection()
        verify(findChild(c.section, "remove_jarvis-clock").visible)
        verify(!findChild(c.section, "install_jarvis-clock").visible)
        verify(findChild(c.section, "install_jarvis-web").visible)
        verify(!findChild(c.section, "remove_jarvis-web").visible)
    }

    function test_installAsksThroughTheModel() {
        const c = makeSection()
        const installs = createTemporaryObject(spyComponent, testCase, { target: c.registry, signalName: "installRequested" })
        const removes = createTemporaryObject(spyComponent, testCase, { target: c.registry, signalName: "removeRequested" })
        mouseClick(findChild(c.section, "install_jarvis-web"))
        compare(installs.count, 1)
        compare(installs.signalArguments[0][0], "jarvis-web")
        compare(installs.signalArguments[0][1], "1.0.0")
        mouseClick(findChild(c.section, "remove_jarvis-clock"))
        compare(removes.signalArguments[0][0], "jarvis-clock")
    }

    function test_communityExplainsItAlwaysAsks() {
        const c = makeSection()
        verify(findChild(c.section, "tierDetail_weather").text.indexOf("asks you before every action") >= 0)
        const name = findChild(c.section, "toolName_weather")
        compare(name.text, "<i>Weather</i>")
        compare(name.textFormat, Text.PlainText)
        compare(findChild(c.section, "toolDescription_weather").textFormat, Text.PlainText)
        compare(findChild(c.section, "tierDetail_weather").textFormat, Text.PlainText)
    }

    function test_filterNarrowsTheList() {
        const c = makeSection()
        const filter = findChild(c.section, "toolFilter")
        filter.forceActiveFocus()
        for (const ch of "web")
            keyClick(ch)
        compare(c.registry.count, 1)
        verify(findChild(c.section, "tool_jarvis-web"))
    }

    function test_emptyAndFilteredEmptyStates() {
        const c = makeSection()
        verify(!findChild(c.section, "toolsEmpty").visible)
        c.registry.filter = "missing"
        verify(findChild(c.section, "toolsEmpty").visible)
        c.registry.filter = ""
        c.registry.applyList({ installed: [], available: [] })
        verify(findChild(c.section, "toolsEmpty").visible)
    }

    function test_updateOffersInstallAndRemove() {
        const c = makeSection()
        c.registry.applyList({ installed: [entry("weather", "0.2", "community", true)],
                               available: [entry("weather", "0.3", "community", true)] })
        waitForRendering(c.section)
        compare(findChild(c.section, "install_weather").text, "Update")
        verify(findChild(c.section, "remove_weather").visible)
    }

    function test_errorShowsAsPlainText() {
        const c = makeSection()
        c.registry.applyError("The registry index signature didn't verify.")
        const error = findChild(c.section, "toolsError")
        verify(error.visible)
        compare(error.textFormat, Text.PlainText)
    }
}
