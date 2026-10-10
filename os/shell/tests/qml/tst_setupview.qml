import QtQuick
import Jarvis.UI
import QtTest
import Jarvis.Shell

TestCase {
    id: testCase
    name: "SetupView"
    when: windowShown
    visible: true
    width: 1200
    height: 900

    Component { id: providerComponent; ProviderModel {} }
    Component { id: viewComponent; SetupView {} }
    Component { id: spyComponent; SignalSpy {} }

    function makeView() {
        const provider = createTemporaryObject(providerComponent, testCase)
        provider.loadList({ active: null, kinds: ["anthropic", "openai-compatible", "ollama"] })
        const view = createTemporaryObject(viewComponent, testCase, { provider: provider, width: 1200, height: 900 })
        waitForRendering(view)
        return { provider: provider, view: view }
    }

    function typeInto(field, text) {
        field.forceActiveFocus()
        for (const ch of text)
            keyClick(ch)
    }

    function test_cloudIsTheDefault() {
        const c = makeView()
        verify(findChild(c.view, "mode_cloud").selected)
        verify(findChild(c.view, "preset_Anthropic").selected)
        verify(findChild(c.view, "apiKey").visible)
        verify(findChild(c.view, "privacyText").text.indexOf("Anthropic") >= 0)
        verify(!findChild(c.view, "startButton").enabled)
    }

    function test_cloudSetupFlow() {
        const c = makeView()
        const probes = createTemporaryObject(spyComponent, testCase, { target: c.provider, signalName: "probeRequested" })
        const saves = createTemporaryObject(spyComponent, testCase, { target: c.provider, signalName: "saveRequested" })
        const saved = createTemporaryObject(spyComponent, testCase, { target: c.provider, signalName: "saved" })
        const key = findChild(c.view, "apiKey")
        typeInto(key.input, "sk-test")
        compare(key.input.echoMode, TextInput.Password)
        mouseClick(findChild(c.view, "checkButton"))
        compare(probes.count, 1)
        compare(probes.signalArguments[0][0], { kind: "anthropic", baseUrl: "https://api.anthropic.com", model: "", apiKey: "sk-test" })
        c.provider.applyProbeResult({ ok: false, supportsTools: false, models: ["claude-a", "claude-b"], error: "pick a model" })
        compare(probes.count, 2)
        compare(probes.signalArguments[1][0].model, "claude-a")
        c.provider.applyProbeResult({ ok: true, supportsTools: true, models: ["claude-a", "claude-b"] })
        verify(findChild(c.view, "probeText").text.indexOf("Tool calling works") >= 0)
        const start = findChild(c.view, "startButton")
        verify(start.enabled)
        mouseClick(start)
        compare(saves.count, 1)
        compare(saves.signalArguments[0][0].apiKey, "sk-test")
        c.provider.applySaveResult({ ok: true, supportsTools: true, models: ["claude-a"] })
        compare(saved.count, 1)
        compare(c.provider.apiKey, "")
        compare(key.input.text, "")
    }

    function test_localMode() {
        const c = makeView()
        mouseClick(findChild(c.view, "mode_local"))
        compare(c.provider.mode, "local")
        const url = findChild(c.view, "ollamaUrl")
        verify(url.visible)
        compare(url.input.text, "http://localhost:11434")
        verify(!findChild(c.view, "apiKey").visible)
        compare(findChild(c.view, "privacyText").text, "Diagnosis logs stay on your own machines.")
    }

    function test_modelWithoutToolsWarns() {
        const c = makeView()
        mouseClick(findChild(c.view, "mode_local"))
        c.provider.model = "tiny"
        mouseClick(findChild(c.view, "checkButton"))
        c.provider.applyProbeResult({ ok: true, supportsTools: false, models: ["tiny"] })
        verify(findChild(c.view, "probeText").text.indexOf("can't control the OS") >= 0)
        verify(findChild(c.view, "startButton").enabled)
    }

    function test_errorOffersTheDoctorOnlyWhenOffline() {
        const c = makeView()
        const doctor = createTemporaryObject(spyComponent, testCase, { target: c.view, signalName: "doctorRequested" })
        typeInto(findChild(c.view, "apiKey").input, "sk-x")
        c.provider.model = "m"
        mouseClick(findChild(c.view, "checkButton"))
        c.provider.applyProbeResult({ ok: false, supportsTools: false, models: [], error: "getaddrinfo ENOTFOUND api.anthropic.com" })
        compare(findChild(c.view, "probeText").text, "getaddrinfo ENOTFOUND api.anthropic.com")
        verify(!findChild(c.view, "startButton").enabled)
        const link = findChild(c.view, "setupDoctor")
        verify(!link.visible) // the machine is online: not a network problem
        c.view.doctorAvailable = true
        verify(link.visible)
        mouseClick(link)
        compare(doctor.count, 1)
    }

    function test_disabledModelPickerIsDark() {
        const c = makeView()
        const picker = findChild(c.view, "modelPicker")
        verify(!picker.enabled) // no models before the connection check
        compare(picker.background.color.toString(), Theme.fieldDisabled.toString())
        compare(picker.contentItem.color.toString(), Theme.textDisabled.toString())
    }
}
