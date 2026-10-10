import QtQuick
import Jarvis.UI

// Shared settings bindings for the shell frame and standalone window.
Item {
    id: page
    required property ShellController shell
    signal doctorRequested()

    LayoutMirroring.enabled: Qt.application.layoutDirection === Qt.RightToLeft
    LayoutMirroring.childrenInherit: true

    SettingsView {
        anchors.fill: parent
        shell: page.shell
        provider: page.shell.provider
        accounts: page.shell.accounts
        providers: page.shell.providers
        memory: page.shell.memory
        registry: page.shell.registry
        voice: page.shell.voice
        phone: page.shell.phone
        cuSettings: page.shell.cuSettings
        doctorAvailable: page.shell.system.known && !page.shell.system.online
        onDoctorRequested: page.doctorRequested()
    }
}
