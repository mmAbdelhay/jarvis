import QtQuick
import QtQuick.Shapes

// A stroke icon drawn from SVG path data in a 24x24 box (no image plugins needed).
Item {
    id: icon
    property string path
    property color color: Theme.muted
    property real strokeWidth: 1.8
    property int size: 22
    // Directional glyphs (arrows, chevrons) point the other way in Arabic.
    property bool mirrorInRtl: false
    transform: Scale {
        origin.x: icon.width / 2
        xScale: icon.mirrorInRtl && Qt.application.layoutDirection === Qt.RightToLeft ? -1 : 1
    }

    implicitWidth: size
    implicitHeight: size

    Shape {
        width: 24
        height: 24
        anchors.centerIn: parent
        scale: icon.size / 24
        preferredRendererType: Shape.CurveRenderer
        ShapePath {
            strokeColor: icon.color
            strokeWidth: icon.strokeWidth
            fillColor: "transparent"
            capStyle: ShapePath.RoundCap
            joinStyle: ShapePath.RoundJoin
            PathSvg { path: icon.path }
        }
    }
}
