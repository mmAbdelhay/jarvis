import QtQuick
import QtQuick.Layouts
import QtQuick.Controls.Basic
import Jarvis.UI

// The Apps menu: search, then installed applications (names from .desktop
// files: plain text). Enter starts the first match, Esc closes.
Rectangle {
    id: root
    required property ClassicController controller

    function focusSearch() { search.forceActiveFocus(Qt.OtherFocusReason) }

    color: Theme.surface
    radius: Theme.radiusCard
    border.color: Theme.border
    LayoutMirroring.enabled: Qt.application.layoutDirection === Qt.RightToLeft
    LayoutMirroring.childrenInherit: true

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 12
        spacing: 8

        TextField {
            id: search
            objectName: "appSearch"
            Layout.fillWidth: true
            implicitHeight: Theme.controlHeight
            leftPadding: 12
            rightPadding: 12
            placeholderText: qsTr("Search apps")
            placeholderTextColor: Theme.mutedSoft
            color: Theme.text
            font.pixelSize: Theme.fontSize
            background: Rectangle { radius: Theme.radiusControl; color: Theme.surfaceDeep; border.color: Theme.borderStrong }
            onTextChanged: root.controller.apps.filter = text
            Keys.onReturnPressed: root.controller.launchFirst()
            Keys.onEnterPressed: root.controller.launchFirst()
            Keys.onEscapePressed: root.controller.closeApps()
        }

        ListView {
            id: list
            objectName: "appList"
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true
            model: root.controller.apps
            ScrollBar.vertical: ScrollBar {}
            delegate: ItemDelegate {
                id: row
                required property string appId
                required property string name
                required property string comment
                objectName: "app_" + appId
                width: ListView.view.width
                Accessible.name: name
                contentItem: Column {
                    spacing: 2
                    Text {
                        width: parent.width
                        text: row.name
                        textFormat: Text.PlainText
                        color: Theme.text
                        font.pixelSize: Theme.fontSize
                        elide: Text.ElideRight
                    }
                    Text {
                        width: parent.width
                        visible: row.comment.length > 0
                        text: row.comment
                        textFormat: Text.PlainText
                        color: Theme.muted
                        font.pixelSize: Theme.fontTiny
                        elide: Text.ElideRight
                    }
                }
                background: Rectangle { radius: Theme.radiusControl; color: row.hovered ? Theme.surfaceRaised : "transparent" }
                onClicked: root.controller.launchApp(appId)
            }
        }

        Text {
            objectName: "noApps"
            Layout.alignment: Qt.AlignHCenter
            visible: list.count === 0
            text: qsTr("No apps match.")
            color: Theme.muted
        }
    }
}
