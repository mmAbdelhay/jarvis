import QtQuick
import QtTest
import Jarvis.Shell

TestCase {
    name: "SettingsWindow"
    when: windowShown

    Component { id: windowComponent; SettingsWindow { shell: testShell } }
    Component { id: spyComponent; SignalSpy {} }

    function cleanup() { testLanguage.setLanguage("en") }

    function test_connectionOpensSettingsAndRefreshesModels() {
        testSettingsShell.provider.loadList({active: {
            id: "local", kind: "ollama", baseUrl: "http://localhost:11434",
            model: "qwen3:8b", hasKey: false
        }})
        testSettingsShell.provider.startNew()
        testSettingsShell.showView("chat")
        const w = createTemporaryObject(windowComponent, this, {shell: testSettingsShell})
        w.show()
        const memorySpy = createTemporaryObject(spyComponent, this,
            {target: testSettingsShell.memory, signalName: "listRequested"})
        const registrySpy = createTemporaryObject(spyComponent, this,
            {target: testSettingsShell.registry, signalName: "listRequested"})
        const phoneSpy = createTemporaryObject(spyComponent, this,
            {target: testSettingsShell.phone, signalName: "statusRequested"})

        // Drive the real controller's transport signals without a daemon.
        testSettingsClient.closed()
        compare(testSettingsShell.connection, "reconnecting")
        compare(testSettingsShell.view, "chat")
        compare(memorySpy.count, 0)
        compare(registrySpy.count, 0)
        compare(phoneSpy.count, 0)

        testSettingsClient.opened()
        compare(testSettingsShell.connection, "open")
        compare(testSettingsShell.view, "settings")
        compare(testSettingsShell.provider.editingId, "local")
        compare(testSettingsShell.provider.model, "qwen3:8b")
        compare(memorySpy.count, 1)
        compare(registrySpy.count, 1)
        compare(phoneSpy.count, 1)

        // A later reconnection refreshes the standalone Settings again.
        testSettingsClient.closed()
        compare(memorySpy.count, 1)
        compare(registrySpy.count, 1)
        testSettingsClient.opened()
        compare(testSettingsShell.view, "settings")
        compare(memorySpy.count, 2)
        compare(registrySpy.count, 2)
        compare(phoneSpy.count, 2)
    }

    function test_showsSettingsOnItsOwn() {
        const w = createTemporaryObject(windowComponent, this)
        w.show()
        compare(w.title, "Jarvis Settings")
        const page = findChild(w.contentItem, "settingsPage")
        verify(page)
        verify(findChild(page, "providersSection"))
        verify(findChild(page, "section_language"))
        verify(!findChild(w.contentItem, "navChat"))   // no chat frame in this window
    }

    function test_arabicTitleAndMirroring() {
        verify(testLanguage.setLanguage("ar"))
        const w = createTemporaryObject(windowComponent, this)
        w.show()
        compare(w.title, "إعدادات جارفيس")
        verify(findChild(w.contentItem, "settingsRoot").LayoutMirroring.enabled)
    }
}
