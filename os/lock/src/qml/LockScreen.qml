import QtQuick
import QtQuick.Layouts
import Jarvis.UI

// One output's lock surface with the greeter's look (M2 Login design). Only
// the primary output takes the password; the others show the clock.
Rectangle {
    id: root
    required property LockModel lock
    property bool primary: true

    color: Theme.surfaceDeep

    function focusField() {
        if (root.primary)
            panel.focusField()
    }
    Component.onCompleted: Qt.callLater(root.focusField)
    Connections {
        target: root.lock
        function onStateChanged() {
            if (root.lock.state === "ready") {
                panel.clear()
                Qt.callLater(root.focusField)
            }
        }
    }

    Icon {
        x: (root.width - width) / 2
        y: 0
        path: Icons.rings
        color: Theme.ringFaint
        strokeWidth: 0.25
        size: Math.min(root.width, root.height)
    }
    ClockHeader {
        anchors.top: parent.top
        anchors.topMargin: 96
        anchors.horizontalCenter: parent.horizontalCenter
    }
    PasswordPanel {
        id: panel
        objectName: "passwordPanel"
        anchors.centerIn: parent
        visible: root.primary
        initial: root.lock.initial
        displayName: root.lock.displayName
        submitLabel: "Unlock"
        busy: root.lock.state !== "ready"
        errorText: root.lock.state === "cooldown"
                   ? root.lock.errorText + " Try again in " + root.lock.cooldownSeconds + " s."
                   : root.lock.errorText
        infoText: root.lock.state === "checking" ? "Checking…" : ""
        onSubmitted: (secret) => root.lock.submit(secret)
    }
    RowLayout {
        anchors.bottom: parent.bottom
        anchors.bottomMargin: 32
        anchors.horizontalCenter: parent.horizontalCenter
        spacing: 8
        Icon { path: Icons.lock; color: Theme.muted; size: 16 }
        Text {
            objectName: "lockedLabel"
            text: "Locked"
            color: Theme.muted
            font.pixelSize: Theme.fontSmall
        }
    }
}
