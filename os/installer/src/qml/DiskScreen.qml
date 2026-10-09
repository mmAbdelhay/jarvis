import QtQuick
import QtQuick.Layouts
import QtQuick.Controls.Basic
import Jarvis.UI

// Step 2 (design: "Where should Rafiq go?"). Picks build Choices.disk only;
// nothing touches the disk before Review's Install.
ColumnLayout {
    id: root
    required property InstallerModel installer
    readonly property DiskChoice disk: installer.disk

    spacing: 20

    ScreenTitle {
        Layout.fillWidth: true
        title: qsTr("Where should %1 go?").arg(Brand.distroName)
        subtitle: root.disk.description
    }

    LabeledCombo {
        objectName: "diskPicker"
        Layout.fillWidth: true
        visible: root.disk.disks.length > 1
        label: qsTr("Disk")
        model: root.disk.disks
        value: root.disk.diskPath
        onPicked: (v) => root.disk.diskPath = v
    }

    ColumnLayout {
        Layout.fillWidth: true
        spacing: 10
        Accessible.role: Accessible.Grouping
        Accessible.name: qsTr("Disk layout")
        Repeater {
            model: root.disk.options
            delegate: ChoiceTile {
                required property var modelData
                objectName: "option_" + modelData.id
                Layout.fillWidth: true
                title: modelData.title
                detail: modelData.detail
                enabled: modelData.enabled
                selected: root.disk.mode === modelData.id
                onClicked: root.disk.mode = modelData.id
            }
        }
    }

    ColumnLayout {
        objectName: "alongsideSize"
        Layout.fillWidth: true
        visible: root.disk.mode === "alongside"
        spacing: 6
        Text {
            objectName: "alongsideText"
            text: root.disk.alongsideText
            textFormat: Text.PlainText
            color: Theme.textSoft
        }
        Slider {
            objectName: "alongsideSlider"
            Layout.fillWidth: true
            from: root.disk.alongsideMinBytes
            to: root.disk.alongsideMaxBytes
            stepSize: 1e9
            value: root.disk.alongsideBytes
            Accessible.name: qsTr("Space for %1").arg(Brand.distroName)
            onMoved: root.disk.alongsideBytes = value
        }
    }

    ColumnLayout {
        objectName: "afterBar"
        Layout.fillWidth: true
        visible: root.disk.barVisible
        spacing: 4
        Text { text: qsTr("After install"); color: Theme.muted; font.pixelSize: Theme.fontSmall }
        Rectangle {
            Layout.fillWidth: true
            implicitHeight: 28
            radius: 8
            clip: true
            color: Theme.accentTintBorder
            Rectangle {
                id: otherPart
                anchors.left: parent.left
                width: parent.width * root.disk.otherFraction
                height: parent.height
                color: Theme.otherOs
                visible: width > 0
                Text {
                    anchors.left: parent.left
                    anchors.leftMargin: 10
                    width: parent.width - 12
                    anchors.verticalCenter: parent.verticalCenter
                    text: root.disk.otherLabel
                    textFormat: Text.PlainText
                    color: Theme.otherOsText
                    font.pixelSize: Theme.fontTiny
                    elide: Text.ElideRight
                }
            }
            Text {
                anchors.left: otherPart.right
                anchors.leftMargin: 10
                anchors.verticalCenter: parent.verticalCenter
                text: root.disk.ourLabel
                textFormat: Text.PlainText
                color: Theme.accentTintText
                font.pixelSize: Theme.fontTiny
            }
        }
    }

    ColumnLayout {
        objectName: "manualTable"
        Layout.fillWidth: true
        visible: root.disk.mode === "manual"
        spacing: 8
        Repeater {
            model: root.disk.manualRows
            delegate: RowLayout {
                required property var modelData
                Layout.fillWidth: true
                spacing: 12
                Text {
                    Layout.preferredWidth: 170
                    text: modelData.path
                    textFormat: Text.PlainText
                    color: Theme.text
                    font.family: Theme.mono
                    font.pixelSize: Theme.fontSmall
                }
                Text {
                    Layout.fillWidth: true
                    text: modelData.fs + (modelData.label.length > 0 ? " · " + modelData.label : "") + " · " + modelData.sizeText
                    textFormat: Text.PlainText
                    color: Theme.muted
                    font.pixelSize: Theme.fontSmall
                    elide: Text.ElideRight
                }
                ThemedCombo {
                    objectName: "mount_" + modelData.path
                    implicitWidth: 150
                    model: root.disk.mountPoints
                    currentIndex: root.disk.mountPoints.indexOf(modelData.mount)
                    displayText: currentText.length > 0 ? currentText : qsTr("Not used")
                    Accessible.name: qsTr("Use %1 as").arg(modelData.path)
                    onActivated: (i) => root.disk.setManualMount(modelData.path, root.disk.mountPoints[i])
                }
                CheckRow {
                    objectName: "format_" + modelData.path
                    text: qsTr("Format")
                    enabled: modelData.mount.length > 0 && modelData.mount !== "/"
                    checked: modelData.format
                    onToggled: root.disk.setManualFormat(modelData.path, checked)
                }
            }
        }
        Text {
            Layout.fillWidth: true
            objectName: "manualLimits"
            text: qsTr("Manual mode makes no partition-table changes. / must be formatted; /boot/efi must be an existing EF00 partition of at least 300 MB. Encrypted installs also need a separate, unencrypted /boot partition of at least 500 MB, which is formatted, and use a swapfile, with no swap partition. LVM and RAID are not offered.")
            color: Theme.mutedSoft
            font.pixelSize: Theme.fontSmall
            wrapMode: Text.Wrap
        }
    }

    CheckRow {
        id: encrypt
        objectName: "encrypt"
        Layout.fillWidth: true
        text: qsTr("Encrypt %1 (recommended). You'll type a passphrase at every start.").arg(Brand.distroName)
        checked: root.disk.encrypt
        onToggled: {
            root.disk.encrypt = checked
            checked = Qt.binding(() => root.disk.encrypt)
        }
    }
}
