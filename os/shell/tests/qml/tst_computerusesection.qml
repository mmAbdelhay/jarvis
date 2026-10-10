import QtQuick
import QtTest
import Jarvis.UI
import Jarvis.Shell

TestCase {
    id: testCase
    name: "ComputerUseSection"
    when: windowShown
    visible: true
    width: 900
    height: 1200

    Component { id: settingsComponent; CuSettingsModel {} }
    Component { id: sectionComponent; ComputerUseSection { width: 860 } }
    Component { id: providerComponent; ProviderModel {} }
    Component { id: listComponent; ProviderListModel {} }
    Component { id: viewComponent; SettingsView {} }
    Component { id: spyComponent; SignalSpy {} }

    function cleanup() { testLanguage.setLanguage("en") }

    readonly property var providerList: ({
        providers: [
            { id: "local", kind: "ollama", baseUrl: "http://localhost:11434", model: "qwen2.5vl:7b", hasKey: false, vision: true },
            { id: "work", kind: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-5-5", hasKey: true, vision: true },
            { id: "tiny", kind: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen3:1.7b", hasKey: false, vision: false }
        ],
        activeId: "local", allowCloudFallback: false
    })

    function make() {
        const settings = createTemporaryObject(settingsComponent, testCase)
        settings.loadList(providerList)
        const section = createTemporaryObject(sectionComponent, testCase, { settings: settings })
        waitForRendering(section)
        return { settings: settings, section: section }
    }

    function test_offByDefaultWithPrivacyAndReasons() {
        const c = make()
        verify(!findChild(c.section, "cuToggle_local").checked)
        verify(!findChild(c.section, "cuToggle_work").checked)
        verify(findChild(c.section, "cuToggle_local").enabled)
        verify(!findChild(c.section, "cuToggle_tiny").enabled)
        compare(findChild(c.section, "cuToggle_work").text, "Let claude-sonnet-5-5 · Anthropic use the screen")
        compare(findChild(c.section, "cuReason_tiny").text, "This model can't see images, so it can't use the screen.")
        verify(findChild(c.section, "cuReason_tiny").visible)
        verify(!findChild(c.section, "cuReason_local").visible)
        compare(findChild(c.section, "cuPrivacy_local").text, "Screenshots stay on this computer.")
        compare(findChild(c.section, "cuPrivacy_work").text, "Screenshots of the allowed windows go to Anthropic.")
        verify(!findChild(c.section, "cuConsent").visible)
        verify(!findChild(c.section, "cuEmpty").visible)
    }

    function test_localSwitchSendsAtOnce() {
        const c = make()
        const enables = createTemporaryObject(spyComponent, testCase, { target: c.settings, signalName: "setEnabledRequested" })
        mouseClick(findChild(c.section, "cuToggle_local"))
        compare(enables.count, 1)
        compare(enables.signalArguments[0][0], "local")
        compare(enables.signalArguments[0][1], true)
        verify(!findChild(c.section, "cuToggle_local").checked) // shows jarvisd's answer, not the click
        c.settings.applyEnabledResult("local", true, true, "", "")
        tryVerify(() => findChild(c.section, "cuToggle_local").checked)
    }

    function test_cloudSwitchAsksForConsent() {
        const c = make()
        const enables = createTemporaryObject(spyComponent, testCase, { target: c.settings, signalName: "setEnabledRequested" })
        const consents = createTemporaryObject(spyComponent, testCase, { target: c.settings, signalName: "consentRequested" })
        mouseClick(findChild(c.section, "cuToggle_work"))
        waitForRendering(c.section)
        const dialog = findChild(c.section, "cuConsent")
        verify(dialog.visible)
        compare(findChild(c.section, "cuConsentTitle").text, "Send screenshots to Anthropic?")
        compare(findChild(c.section, "cuConsentBody").text,
                "While Jarvis uses the screen, screenshots of the allowed windows are sent to Anthropic. Other windows are blacked out, and screenshots are never saved.")
        verify(findChild(c.section, "cuConsentCancel").activeFocus) // the safe answer has focus
        compare(enables.count, 0)
        mouseClick(findChild(c.section, "cuConsentAllow"))
        compare(consents.count, 1)
        compare(consents.signalArguments[0][0], "work")
        compare(enables.count, 0)
    }

    function test_cancelSendsNothing() {
        const c = make()
        const enables = createTemporaryObject(spyComponent, testCase, { target: c.settings, signalName: "setEnabledRequested" })
        const consents = createTemporaryObject(spyComponent, testCase, { target: c.settings, signalName: "consentRequested" })
        mouseClick(findChild(c.section, "cuToggle_work"))
        waitForRendering(c.section)
        mouseClick(findChild(c.section, "cuConsentCancel"))
        waitForRendering(c.section)
        verify(!findChild(c.section, "cuConsent").visible)
        verify(!findChild(c.section, "cuToggle_work").checked)
        compare(enables.count, 0)
        compare(consents.count, 0)
    }

    function test_noteAndEmpty() {
        const c = make()
        mouseClick(findChild(c.section, "cuToggle_local"))
        c.settings.applyEnabledResult("local", true, false, "unsupported", "unknown channel")
        waitForRendering(c.section)
        const note = findChild(c.section, "cuNote")
        verify(note.visible)
        compare(note.text, "This version of Jarvis can't use the screen yet.")
        compare(note.textFormat, Text.PlainText)
        c.settings.loadList({ providers: [] })
        waitForRendering(c.section)
        verify(findChild(c.section, "cuEmpty").visible)
    }

    function test_excludedAppsAreReadOnly() {
        const c = make()
        for (let i = 0; i < 6; ++i)
            verify(findChild(c.section, "cuExcluded_" + i).visible)
        compare(findChild(c.section, "cuExcluded_0").text, "Jarvis apps, the shell and Settings")
        compare(findChild(c.section, "cuExcluded_5").text, "Password fields in any app")
        compare(findChild(c.section, "cuExcluded_6"), null)
    }

    function test_settingsViewHasTheSection() {
        const provider = createTemporaryObject(providerComponent, testCase)
        const providers = createTemporaryObject(listComponent, testCase)
        provider.loadList(providerList)
        providers.loadList(providerList)
        const settings = createTemporaryObject(settingsComponent, testCase)
        settings.loadList(providerList)
        const view = createTemporaryObject(viewComponent, testCase,
                                           { provider: provider, providers: providers, cuSettings: settings, width: 900, height: 1200 })
        waitForRendering(view)
        const chip = findChild(view, "section_computerUse")
        verify(chip)
        compare(chip.Accessible.name, "Computer use")
        verify(!findChild(view, "computerUseSection").visible)
        mouseClick(chip)
        waitForRendering(view)
        verify(findChild(view, "computerUseSection").visible)
        verify(findChild(view, "cuToggle_local"))
    }

    function test_arabicTranslatesAndMirrors() {
        verify(testLanguage.setLanguage("ar"))
        const c = make()
        compare(findChild(c.section, "cuToggle_local").text, "اسمح لـ qwen2.5vl:7b · على هذا الحاسوب باستخدام الشاشة")
        mouseClick(findChild(c.section, "cuToggle_work"))
        waitForRendering(c.section)
        compare(findChild(c.section, "cuConsentTitle").text, "إرسال لقطات الشاشة إلى Anthropic؟")
        compare(findChild(c.section, "cuConsentAllow").text, "اسمح وشغّل")
        const allow = findChild(c.section, "cuConsentAllow")
        const cancel = findChild(c.section, "cuConsentCancel")
        verify(allow.mapToItem(c.section, 0, 0).x < cancel.mapToItem(c.section, 0, 0).x) // mirrored row
        compare(findChild(c.section, "cuExcluded_1").text, "شاشة القفل")
    }
}
