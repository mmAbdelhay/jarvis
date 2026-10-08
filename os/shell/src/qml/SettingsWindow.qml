import QtQuick
import QtQuick.Layouts
import Jarvis.UI

// `jarvis-shell --settings` (Rafiq M4 contracts §2): Settings and the Network
// doctor in an ordinary window, for classic mode and for when the full shell
// cannot start.
Window {
    id: window
    required property ShellController shell

    title: qsTr("Jarvis Settings")
    width: 1100
    height: 800
    minimumWidth: 720
    minimumHeight: 520
    color: Theme.bg
    visible: false

    Connections {
        target: window.shell
        function onConnectionChanged() {
            if (window.shell.connection === "open")
                window.shell.showView("settings")
        }
    }

    Rectangle {
        objectName: "settingsRoot"
        anchors.fill: parent
        color: Theme.bg
        LayoutMirroring.enabled: Qt.application.layoutDirection === Qt.RightToLeft
        LayoutMirroring.childrenInherit: true

        StackLayout {
            anchors.fill: parent
            currentIndex: window.shell.view === "doctor" ? 1 : 0
            SettingsPage {
                objectName: "settingsPage"
                shell: window.shell
                onDoctorRequested: window.shell.openDoctor()
            }
            DoctorView {
                doctor: window.shell.doctor
                card: window.shell.doctorCard
                providerError: window.shell.providerError
                onBackRequested: window.shell.showView("settings")
                onDecided: (approve) => window.shell.decide(window.shell.doctorCard, approve)
            }
        }
    }
}
