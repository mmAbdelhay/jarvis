import QtQuick
import Jarvis.UI
import QtQuick.Layouts

// The whole shell surface: top bar, banner, nav rail, the current view and
// (in chat) the machine panel. Setup and the doctor are full-screen.
Rectangle {
    id: root
    required property ShellController shell

    readonly property var viewNames: ["loading", "setup", "chat", "doctor", "audit", "settings"]
    readonly property bool framed: shell.view !== "setup" && shell.view !== "doctor"

    color: Theme.bg

    Shortcut {
        sequence: "Esc"
        context: Qt.ApplicationShortcut
        onActivated: root.shell.escape()
    }
    Shortcut {
        sequence: "Ctrl+Alt+T"
        context: Qt.ApplicationShortcut
        onActivated: root.shell.openTerminal()
    }
    Connections {
        target: root.shell
        function onComposerFocusRequested() {
            root.shell.showView("chat")
            chat.focusComposer()
        }
    }

    ColumnLayout {
        anchors.fill: parent
        spacing: 0

        TopBar {
            Layout.fillWidth: true
            visible: root.framed
            shell: root.shell
        }
        Banner {
            objectName: "banner"
            Layout.fillWidth: true
            visible: root.framed && root.shell.bannerText.length > 0
            text: root.shell.bannerText
            showDoctor: root.shell.offerDoctor
            showSettings: root.shell.connection === "open" && !root.shell.providerReachable
            onDoctorRequested: root.shell.openDoctor()
            onSettingsRequested: root.shell.showView("settings")
        }

        RowLayout {
            Layout.fillWidth: true
            Layout.fillHeight: true
            spacing: 0

            NavRail {
                Layout.fillHeight: true
                visible: root.framed
                current: root.shell.view
                onNavigate: (view) => root.shell.showView(view)
                onTerminalRequested: root.shell.openTerminal()
            }

            StackLayout {
                objectName: "views"
                Layout.fillWidth: true
                Layout.fillHeight: true
                currentIndex: Math.max(0, root.viewNames.indexOf(root.shell.view))

                Item {
                    Text {
                        objectName: "loadingText"
                        anchors.centerIn: parent
                        text: root.shell.connection === "open" ? "Loading…" : "Connecting to Jarvis…"
                        color: Theme.muted
                    }
                }
                SetupView {
                    provider: root.shell.provider
                    doctorAvailable: root.shell.system.known && !root.shell.system.online
                    onDoctorRequested: root.shell.openDoctor()
                }
                ChatView {
                    id: chat
                    conversation: root.shell.conversation
                    card: root.shell.chatCard
                    onSubmit: (text) => root.shell.sendPrompt(text)
                    onStopRequested: root.shell.stop()
                    onDecided: (approve) => root.shell.decide(root.shell.chatCard, approve)
                }
                DoctorView {
                    doctor: root.shell.doctor
                    card: root.shell.doctorCard
                    providerError: root.shell.providerError
                    onBackRequested: root.shell.showView("chat")
                    onDecided: (approve) => root.shell.decide(root.shell.doctorCard, approve)
                }
                AuditView {
                    audit: root.shell.audit
                    onBackRequested: root.shell.showView("chat")
                }
                SettingsView {
                    provider: root.shell.provider
                    providers: root.shell.providers
                    memory: root.shell.memory
                    registry: root.shell.registry
                    doctorAvailable: root.shell.system.known && !root.shell.system.online
                    onDoctorRequested: root.shell.openDoctor()
                }
            }

            MachinePanel {
                objectName: "machinePanel"
                Layout.fillHeight: true
                visible: root.shell.view === "chat"
                shell: root.shell
            }
        }
    }
}
