import QtQuick
import Jarvis.UI
import QtTest
import Jarvis.Shell

TestCase {
    id: testCase
    name: "AccountsSection"
    when: windowShown
    visible: true
    width: 900
    height: 700

    Component { id: accountsComponent; AccountsModel {} }
    Component { id: sectionComponent; AccountsSection {} }
    Component { id: spyComponent; SignalSpy {} }
    Component { id: providerComponent; ProviderModel {} }
    Component { id: providersComponent; ProviderListModel {} }
    Component { id: settingsComponent; SettingsView {} }

    function make() {
        const accounts = createTemporaryObject(accountsComponent, testCase)
        accounts.applyStatus({ accounts: [
            { account: "claude", installed: true, version: "2.1.280", signedIn: true, identity: "sara@example.com" },
            { account: "chatgpt", installed: true, version: "0.159.2", signedIn: false, identity: null },
            { account: "gemini", installed: false, version: null, signedIn: false, identity: null },
            { account: "copilot", installed: true, version: "1.0.89", signedIn: true, identity: "octocat" }
        ] })
        const section = createTemporaryObject(sectionComponent, testCase, { accounts: accounts, width: 800 })
        waitForRendering(section)
        return { accounts: accounts, section: section }
    }

    function test_rowsShowState() {
        const c = make()
        verify(findChild(c.section, "accountRow_claude").statusText.indexOf("sara@example.com") >= 0)
        verify(findChild(c.section, "accountRowSignOut_claude").visible)
        verify(!findChild(c.section, "accountRowSignOut_chatgpt").visible)
        verify(findChild(c.section, "accountRowRemove_chatgpt").visible)
        verify(!findChild(c.section, "accountRowRemove_gemini").visible)
        verify(findChild(c.section, "copilotRevokeNote").visible)
        verify(findChild(c.section, "geminiRevokeNote").visible)
    }

    function test_settingsAccountsSection() {
        const c = make()
        const provider = createTemporaryObject(providerComponent, testCase)
        const providers = createTemporaryObject(providersComponent, testCase)
        const settings = createTemporaryObject(settingsComponent, testCase, {
            provider: provider, providers: providers, accounts: c.accounts, width: 900, height: 700
        })
        mouseClick(findChild(settings, "section_accounts"))
        compare(settings.section, "accounts")
        const loader = findChild(settings, "accountsSection")
        verify(loader.visible)
        verify(loader.item !== null)
        verify(findChild(loader.item, "accountRow_claude") !== null)
        settings.destroy()
        wait(0)
    }

    function test_signOut() {
        const c = make()
        const spy = createTemporaryObject(spyComponent, testCase, { target: c.accounts, signalName: "logoutRequested" })
        mouseClick(findChild(c.section, "accountRowSignOut_claude"))
        compare(spy.count, 1)
        compare(spy.signalArguments[0][0], "claude")
    }

    function test_removeAsksTwice() {
        const c = make()
        const spy = createTemporaryObject(spyComponent, testCase, { target: c.accounts, signalName: "uninstallRequested" })
        mouseClick(findChild(c.section, "accountRowRemove_chatgpt"))
        compare(spy.count, 0)
        mouseClick(findChild(c.section, "accountRowConfirmRemove_chatgpt"))
        compare(spy.count, 1)
        compare(spy.signalArguments[0][0], "chatgpt")
    }
}
