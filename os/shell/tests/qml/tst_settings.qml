import QtQuick
import QtTest
import Jarvis.UI
import Jarvis.Shell

TestCase {
    id: testCase
    name: "Settings"
    when: windowShown
    visible: true
    width: 1200
    height: 1600 // tall enough that the open editor's buttons are on screen

    Component { id: providerComponent; ProviderModel {} }
    Component { id: listComponent; ProviderListModel {} }
    Component { id: viewComponent; SettingsView {} }
    Component { id: spyComponent; SignalSpy {} }

    function makeView() {
        const provider = createTemporaryObject(providerComponent, testCase)
        const providers = createTemporaryObject(listComponent, testCase)
        const list = {
            providers: [
                { id: "local", kind: "ollama", baseUrl: "http://localhost:11434", model: "qwen3:8b", hasKey: false },
                { id: "work", kind: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-5-5", hasKey: true }
            ],
            activeId: "local", allowCloudFallback: false, kinds: ["anthropic", "openai-compatible", "ollama", "gemini"]
        }
        provider.loadList(list)
        providers.loadList(list)
        const view = createTemporaryObject(viewComponent, testCase, { provider: provider, providers: providers, width: 1200, height: 1600 })
        waitForRendering(view)
        return { provider: provider, providers: providers, view: view }
    }

    function test_listsProvidersInOrder() {
        const c = makeView()
        verify(findChild(c.view, "section_providers"))
        verify(findChild(c.view, "providerRow_local").visible)
        verify(findChild(c.view, "providerRow_work").visible)
        verify(!findChild(c.view, "moveUp_local").enabled)
        verify(!findChild(c.view, "moveDown_work").enabled)
        verify(!findChild(c.view, "saveOrder").enabled)
        verify(!findChild(c.view, "providerEditor").visible)
        verify(findChild(c.view, "currentProvider").text.indexOf("qwen3:8b") >= 0)
    }

    function test_reorderAndSave() {
        const c = makeView()
        const saves = createTemporaryObject(spyComponent, testCase, { target: c.providers, signalName: "saveRequested" })
        mouseClick(findChild(c.view, "moveDown_local"))
        compare(c.providers.config(0).id, "work")
        const save = findChild(c.view, "saveOrder")
        verify(save.enabled)
        mouseClick(save)
        compare(saves.count, 1)
        compare(saves.signalArguments[0][0].providers[0].id, "work")
    }

    function test_cloudFallbackToggle() {
        const c = makeView()
        mouseClick(findChild(c.view, "cloudFallback"))
        verify(c.providers.allowCloudFallback)
        verify(c.providers.dirty)
    }

    function test_editOpensTheFormForThatProvider() {
        const c = makeView()
        mouseClick(findChild(c.view, "edit_work"))
        verify(findChild(c.view, "providerEditor").visible)
        compare(c.provider.editingId, "work")
        compare(c.provider.preset, "Anthropic")
        mouseClick(findChild(c.view, "cancelEdit"))
        verify(!findChild(c.view, "providerEditor").visible)
    }

    function test_addStartsANewDraft() {
        const c = makeView()
        c.provider.editProvider(c.providers.config(1))
        mouseClick(findChild(c.view, "addProvider"))
        verify(findChild(c.view, "providerEditor").visible)
        compare(c.provider.editingId, "")
    }

    function test_rowErrorsShowAsPlainText() {
        const c = makeView()
        c.providers.applySaveResult({ ok: false, results: { work: { ok: false, supportsTools: false, models: [], error: "<b>401</b>" } } })
        const error = findChild(c.view, "providerError_work")
        verify(error.visible)
        compare(error.text, "<b>401</b>")
        compare(error.textFormat, Text.PlainText)
        verify(findChild(c.view, "listStatus").text.indexOf("work") >= 0)
    }

    function test_theLastProviderCannotBeRemoved() {
        const c = makeView()
        mouseClick(findChild(c.view, "remove_local"))
        compare(c.providers.count, 1)
        verify(!findChild(c.view, "remove_work").enabled)
    }
}
