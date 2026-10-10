import QtQuick
import Jarvis.UI
import QtQuick.Layouts
import QtQuick.Controls.Basic

// Plan Y §4.1 (design "M3 · Apps"): every installed app (APT .desktop files and
// Flatpak exports) in a searchable grid. A click starts it at once, like
// apps.open; a search with no match offers "Ask Jarvis: <text>". Keyboard:
// type to search, Enter starts the first match, Down enters the grid, arrows
// move, Enter starts; Esc (the shell's own shortcut) returns to chat.
FocusScope {
    id: root
    LayoutMirroring.enabled: Qt.application.layoutDirection === Qt.RightToLeft
    LayoutMirroring.childrenInherit: true
    required property ShellController shell
    readonly property string query: search.text.trim()

    function activateFirst() {
        if (root.shell.apps.count > 0)
            root.shell.launchApp(root.shell.apps.idAt(0))
        else if (root.query.length > 0)
            root.shell.askJarvis(root.query)
    }

    onVisibleChanged: {
        if (visible) {
            search.text = ""
            search.forceActiveFocus()
        }
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 32
        spacing: 20

        Text {
            text: qsTr("Apps")
            color: Theme.text
            font.pixelSize: 30
            font.weight: Font.DemiBold
        }

        TextField {
            id: search
            objectName: "appsSearch"
            Layout.fillWidth: true
            Layout.maximumWidth: 640
            implicitHeight: Theme.controlHeight
            leftPadding: 14
            rightPadding: 14
            placeholderText: qsTr("Search apps, or ask Jarvis")
            placeholderTextColor: Theme.mutedSoft
            color: Theme.text
            font.pixelSize: Theme.fontSize
            Accessible.name: qsTr("Search apps")
            background: Rectangle {
                radius: Theme.radiusControl
                color: Theme.surfaceDeep
                border.color: search.activeFocus ? Theme.accentTintBorder : Theme.borderStrong
            }
            onTextChanged: root.shell.apps.filter = text
            Keys.onReturnPressed: root.activateFirst()
            Keys.onEnterPressed: root.activateFirst()
            Keys.onDownPressed: if (grid.count > 0) grid.forceActiveFocus()
        }

        Text {
            objectName: "appsNotice"
            Layout.fillWidth: true
            visible: root.shell.appsNotice.length > 0
            text: root.shell.appsNotice
            textFormat: Text.PlainText
            wrapMode: Text.Wrap
            color: Theme.warn
        }

        GridView {
            id: grid
            objectName: "appsGrid"
            Layout.fillWidth: true
            Layout.fillHeight: true
            visible: count > 0
            clip: true
            cellWidth: 152
            cellHeight: 136
            model: root.shell.apps
            keyNavigationEnabled: true
            currentIndex: 0
            Keys.onReturnPressed: if (currentItem) root.shell.launchApp(currentItem.appId)
            Keys.onEnterPressed: if (currentItem) root.shell.launchApp(currentItem.appId)
            Keys.onUpPressed: (event) => {
                if (currentIndex < Math.max(1, Math.floor(width / cellWidth))) search.forceActiveFocus()
                else event.accepted = false
            }
            ScrollBar.vertical: ScrollBar {}

            delegate: AbstractButton {
                id: tile
                required property int index
                required property string appId
                required property string name
                required property string comment
                required property var model
                objectName: "app_" + appId
                width: grid.cellWidth - 12
                height: grid.cellHeight - 12
                focusPolicy: Qt.NoFocus // the grid owns keyboard focus; currentIndex marks the tile
                Accessible.role: Accessible.Button
                Accessible.name: name
                Accessible.description: comment
                hoverEnabled: true
                contentItem: ColumnLayout {
                    spacing: 10
                    Item {
                        Layout.alignment: Qt.AlignHCenter
                        implicitWidth: 48
                        implicitHeight: 48
                        Image {
                            id: picture
                            anchors.fill: parent
                            source: tile.model.icon.length > 0 ? "image://appicon/" + encodeURIComponent(tile.model.icon) : ""
                            sourceSize: Qt.size(48, 48)
                            asynchronous: true
                            visible: status === Image.Ready
                        }
                        Rectangle {
                            anchors.fill: parent
                            visible: picture.status !== Image.Ready
                            radius: 12
                            color: Theme.surfaceRaised
                            Text {
                                anchors.centerIn: parent
                                text: tile.name.length > 0 ? tile.name.charAt(0).toUpperCase() : "?"
                                color: Theme.accent
                                font.pixelSize: 22
                                font.weight: Font.DemiBold
                            }
                        }
                    }
                    Text {
                        Layout.fillWidth: true
                        text: tile.name
                        textFormat: Text.PlainText
                        horizontalAlignment: Text.AlignHCenter
                        wrapMode: Text.Wrap
                        maximumLineCount: 2
                        elide: Text.ElideRight
                        color: Theme.text
                        font.pixelSize: Theme.fontSmall
                    }
                }
                background: Rectangle {
                    radius: Theme.radiusCard
                    color: tile.hovered || (grid.activeFocus && tile.GridView.isCurrentItem) ? Theme.surfaceRaised : Theme.surface
                    border.color: grid.activeFocus && tile.GridView.isCurrentItem ? Theme.accentTintBorder : Theme.border
                }
                onClicked: root.shell.launchApp(appId)
            }
        }

        ColumnLayout {
            objectName: "appsEmpty"
            Layout.alignment: Qt.AlignHCenter
            Layout.topMargin: 24
            visible: grid.count === 0
            spacing: 14
            Text {
                Layout.alignment: Qt.AlignHCenter
                text: root.query.length > 0 ? qsTr("No apps match “%1”.").arg(root.query) : qsTr("No apps found.")
                textFormat: Text.PlainText
                color: Theme.muted
            }
            ActionButton {
                objectName: "askJarvis"
                Layout.alignment: Qt.AlignHCenter
                visible: root.query.length > 0
                variant: "primary"
                text: qsTr("Ask Jarvis: %1").arg(root.query)
                onClicked: root.shell.askJarvis(root.query)
            }
        }
    }
}
