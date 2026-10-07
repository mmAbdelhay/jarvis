import QtQuick
import Jarvis.UI

// The root window. main() shows it full screen (or windowed with --windowed).
Window {
    id: window
    required property InstallerModel installer

    title: "Install " + Brand.distroName
    width: 1440
    height: 900
    color: Theme.bg
    visible: false

    InstallerRoot {
        anchors.fill: parent
        installer: window.installer
    }
}
