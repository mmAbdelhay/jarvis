import QtQuick
import Jarvis.UI

// One per output (CuOverlayManager). Transparent, frameless, never focused;
// on Wayland a layer-shell surface on the overlay layer. Input transparency
// and the input region are set from C++ (CuOverlayManager::updateMask).
Window {
    id: window
    required property CuSessionModel session
    property bool primary: false
    readonly property alias inputRects: overlay.inputRects

    title: qsTr("Jarvis screen control")
    color: "transparent"
    visible: false
    flags: Qt.FramelessWindowHint | Qt.WindowDoesNotAcceptFocus | Qt.WindowStaysOnTopHint

    CuOverlay {
        id: overlay
        anchors.fill: parent
        session: window.session
        primary: window.primary
    }
}
