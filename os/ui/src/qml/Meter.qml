import QtQuick

// A thin progress bar (design: Installing, machine panel). fraction is clamped to 0–1.
Rectangle {
    id: root
    property real fraction: 0
    property color fill: Theme.accent

    implicitHeight: 8
    radius: height / 2
    color: Theme.surfaceRaised
    Accessible.role: Accessible.ProgressBar

    Rectangle {
        anchors.left: parent.left
        width: root.width * Math.max(0, Math.min(1, root.fraction))
        height: root.height
        radius: root.radius
        color: root.fill
    }
}
