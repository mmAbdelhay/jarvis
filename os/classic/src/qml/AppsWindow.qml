import QtQuick
import Jarvis.UI

Window {
    id: window
    required property ClassicController controller
    function focusSearch() { menu.focusSearch() }
    title: "jarvis-classic-apps"
    width: 360
    height: 480
    color: "transparent"
    visible: false
    AppsMenu { id: menu; anchors.fill: parent; controller: window.controller }
}
