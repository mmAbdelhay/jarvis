import QtQuick
import Jarvis.UI

// The taskbar's window; ClassicSurfaces makes it a bottom layer-shell bar.
Window {
    id: window
    required property ClassicController controller
    title: "jarvis-classic-taskbar"
    width: 1280
    height: 48
    color: Theme.surfaceDeep
    visible: false
    Taskbar { anchors.fill: parent; controller: window.controller }
}
