import QtQuick
import Jarvis.UI

// The root window. It starts hidden so ShellSurface can make it a
// layer-shell surface before the platform window exists, then shows it.
Window {
    id: window
    required property ShellController shell

    title: "Jarvis"
    width: 1440
    height: 900
    color: Theme.bg
    visible: false

    ShellRoot {
        anchors.fill: parent
        shell: window.shell
    }
}
