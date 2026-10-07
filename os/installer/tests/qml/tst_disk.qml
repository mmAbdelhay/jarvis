import QtQuick
import QtTest
import Jarvis.UI
import Jarvis.Installer

TestCase {
    id: testCase
    name: "DiskScreen"
    when: windowShown
    visible: true
    width: 900
    height: 1000

    Component { id: screenComponent; DiskScreen {} }

    function make(options) {
        const m = harness.fresh(options || {})
        tryCompare(m, "probed", true)
        m.next()
        const s = createTemporaryObject(screenComponent, testCase, { installer: m, width: 780 })
        waitForRendering(s)
        return { m: m, s: s }
    }

    function test_windowsPartitionAndManualLimitsAreShown() {
        const c = make()
        verify(findChild(c.s, "screenSubtitle").text.indexOf("Windows on /dev/nvme0n1p2") >= 0)
        mouseClick(findChild(c.s, "option_manual"))
        const limits = findChild(c.s, "manualLimits").text
        verify(limits.indexOf("no partition-table changes") >= 0)
        verify(limits.indexOf("/ must be formatted") >= 0)
        verify(limits.indexOf("EF00") >= 0)
        verify(limits.indexOf("300 MB") >= 0)
        verify(limits.indexOf("swapfile") >= 0)
    }

    function test_titleAndDescription() {
        const c = make()
        compare(findChild(c.s, "screenTitle").text, "Where should Rafiq go?")
        compare(findChild(c.s, "screenSubtitle").text, "Samsung 980 NVMe · 512 GB · contains Windows on /dev/nvme0n1p2 (210 GB used)")
        verify(!findChild(c.s, "diskPicker").visible)      // liveDevice (the USB stick) is hidden, one disk left
    }

    function test_alongsideIsPreselectedWithItsSize() {
        const c = make()
        verify(findChild(c.s, "option_alongside").selected)
        verify(findChild(c.s, "alongsideSize").visible)
        compare(findChild(c.s, "alongsideText").text, "Give Rafiq 147 GB. Windows keeps 363 GB.")
        verify(findChild(c.s, "afterBar").visible)
        const slider = findChild(c.s, "alongsideSlider")
        slider.forceActiveFocus()
        keyClick(Qt.Key_Right)
        compare(c.m.disk.alongsideBytes, 148e9)
        compare(findChild(c.s, "alongsideText").text, "Give Rafiq 148 GB. Windows keeps 362 GB.")
    }

    function test_eraseSaysWhatItDeletes() {
        const c = make()
        const erase = findChild(c.s, "option_erase")
        compare(erase.detail, "Deletes Windows and every file on this disk.")
        mouseClick(erase)
        compare(c.m.disk.mode, "erase")
        verify(!findChild(c.s, "alongsideSize").visible)
    }

    function test_hibernatedWindowsShowsTheReasonAndCannotBePicked() {
        const c = make({ windows: "hibernated" })
        const alongside = findChild(c.s, "option_alongside")
        verify(!alongside.enabled)
        verify(alongside.detail.indexOf("hold Shift + Shut down") >= 0)
        mouseClick(alongside)
        compare(c.m.disk.mode, "")
        verify(!c.m.canContinue)
    }

    function test_encryptIsOnByDefaultAndToggles() {
        const c = make()
        const encrypt = findChild(c.s, "encrypt")
        verify(encrypt.checked)
        compare(encrypt.text, "Encrypt Rafiq (recommended). You'll type a passphrase at every start.")
        mouseClick(encrypt)
        verify(!c.m.disk.encrypt)
        verify(!c.m.account.encrypt)
        verify(!encrypt.checked)
    }

    function test_manualTableAssignsMounts() {
        const c = make()
        mouseClick(findChild(c.s, "option_manual"))
        verify(findChild(c.s, "manualTable").visible)
        verify(!findChild(c.s, "afterBar").visible)
        const mount = findChild(c.s, "mount_/dev/nvme0n1p2")
        mount.forceActiveFocus()
        keyClick(Qt.Key_Down)                          // "Not used" → "/"
        compare(c.m.disk.manualRows[1].mount, "/")
        verify(findChild(c.s, "format_/dev/nvme0n1p2").checked)
        compare(c.m.disk.blockText, "Choose an EFI system partition for /boot/efi.")
    }
}
