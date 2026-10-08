import QtQuick
import QtQuick.Layouts
import QtQuick.Controls.Basic
import Jarvis.UI

// Settings: model providers in failover order, memory, and tool servers.
Item {
    id: root
    required property ProviderModel provider
    required property ProviderListModel providers
    property MemoryModel memory: null
    property RegistryModel registry: null
    property bool doctorAvailable: false // sys:snapshot says offline (contracts §6.8)
    property string section: "providers"
    readonly property var sections: [{ id: "providers", label: "Model providers" }, { id: "memory", label: "Memory" }, { id: "tools", label: "Tools" }]
    signal doctorRequested()

    Flickable {
        anchors.fill: parent
        contentHeight: column.implicitHeight + 112
        clip: true
        boundsBehavior: Flickable.StopAtBounds

        ColumnLayout {
            id: column
            width: Math.min(820, root.width - 48)
            x: (root.width - width) / 2
            y: 56
            spacing: 24

            ColumnLayout {
                spacing: 6
                Text {
                    text: "Settings"
                    color: Theme.text
                    font.pixelSize: 30
                    font.weight: Font.DemiBold
                }
                Text {
                    objectName: "currentProvider"
                    text: root.provider.hasActive
                          ? "Now: " + root.provider.activeModel + " · " + root.provider.activeLabel + ". Changes apply to your next message."
                          : "No provider yet."
                    textFormat: Text.PlainText
                    color: Theme.muted
                }
            }

            RowLayout {
                spacing: 8
                Repeater {
                    model: root.sections
                    delegate: AbstractButton {
                        id: chip
                        required property var modelData
                        readonly property bool selected: root.section === modelData.id
                        objectName: "section_" + modelData.id
                        implicitHeight: 36
                        implicitWidth: chipText.implicitWidth + 28
                        Accessible.role: Accessible.PageTab
                        Accessible.name: modelData.label
                        contentItem: Text {
                            id: chipText
                            text: chip.modelData.label
                            horizontalAlignment: Text.AlignHCenter
                            verticalAlignment: Text.AlignVCenter
                            color: chip.selected ? Theme.accentTintText : Theme.textSoft
                            font.pixelSize: 14
                        }
                        background: Rectangle {
                            radius: 18
                            color: chip.selected ? Theme.accentTint : "transparent"
                            border.color: chip.selected ? Theme.accentTintBorder : Theme.border
                        }
                        onClicked: root.section = modelData.id
                    }
                }
            }

            ProvidersSection {
                objectName: "providersSection"
                Layout.fillWidth: true
                visible: root.section === "providers"
                provider: root.provider
                providers: root.providers
                doctorAvailable: root.doctorAvailable
                onDoctorRequested: root.doctorRequested()
            }

            Loader {
                objectName: "memorySection"
                Layout.fillWidth: true
                visible: root.section === "memory"
                active: root.memory !== null
                sourceComponent: MemorySection { memory: root.memory }
            }

            Loader {
                objectName: "toolsSection"
                Layout.fillWidth: true
                visible: root.section === "tools"
                active: root.registry !== null
                sourceComponent: ToolsSection { registry: root.registry }
            }
        }
    }
}
