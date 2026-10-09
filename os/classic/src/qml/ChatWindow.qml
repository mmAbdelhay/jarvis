import QtQuick
import Jarvis.UI

Window {
    id: window
    required property ClassicController controller
    function focusComposer() { panel.focusComposer() }
    title: "jarvis-classic-chat"
    width: 420
    height: 800
    color: Theme.bg
    visible: false
    ChatPanel { id: panel; anchors.fill: parent; controller: window.controller }
}
