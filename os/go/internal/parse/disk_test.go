package parse

import (
	"reflect"
	"testing"
)

func TestLsblkListModeWithParents(t *testing.T) {
	devs, err := Lsblk(fixtureBytes(t, "lsblk-windows.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(devs) != 5 {
		t.Fatalf("got %d devices", len(devs))
	}
	if d := devs[0]; d.Path != "/dev/loop1" || d.Parent != "" || d.Type != "loop" || d.Size != 68719476736 || d.LogSec != 512 || d.RM || d.RO {
		t.Fatalf("disk = %+v", d)
	}
	if p := devs[3]; p.Path != "/dev/loop1p3" || p.Parent != "loop1" || p.Type != "part" || p.Size != 67523034624 {
		t.Fatalf("p3 = %+v", p)
	}
	old, err := Lsblk([]byte(`{"blockdevices":[{"path":"/dev/sda","pkname":null,"type":"disk","size":"1000","model":"Samsung SSD  ","rm":"1","ro":"0","log-sec":"512"}]}`))
	if err != nil || !old[0].RM || old[0].RO || old[0].Size != 1000 || old[0].Model != "Samsung SSD" {
		t.Fatalf("old-format lsblk = %+v, %v", old, err)
	}
}

func TestBlkidExportUnescapes(t *testing.T) {
	m := BlkidExport(fixture(t, "blkid-ntfs.txt"))
	want := map[string]string{"TYPE": "ntfs", "LABEL": "Windows", "PART_ENTRY_NAME": "Basic data partition",
		"PART_ENTRY_TYPE": "ebd0a0a2-b9e5-4433-87c0-68b6b72699c7", "PART_ENTRY_NUMBER": "3",
		"PART_ENTRY_OFFSET": "239616", "PART_ENTRY_SIZE": "131880927"}
	for k, v := range want {
		if m[k] != v {
			t.Errorf("%s = %q, want %q", k, m[k], v)
		}
	}
	if m := BlkidExport(fixture(t, "blkid-bitlocker.txt")); m["TYPE"] != "BitLocker" || m["PART_ENTRY_FLAGS"] != "0x1" {
		t.Errorf("bitlocker = %v", m)
	}
	if m := BlkidExport(fixture(t, "blkid-luks.txt")); m["TYPE"] != "crypto_LUKS" || m["UUID"] != "dc3595e8-0075-459c-8ae6-70871177a5d6" {
		t.Errorf("luks = %v", m)
	}
	if m := BlkidExport(fixture(t, "blkid-msr.txt")); m["TYPE"] != "" || m["PART_ENTRY_NUMBER"] != "2" {
		t.Errorf("msr = %v", m)
	}
}

func TestSgdiskPrint(t *testing.T) {
	g, err := SgdiskPrint(fixture(t, "sgdisk-p-windows.txt"))
	if err != nil {
		t.Fatal(err)
	}
	want := GPTGeometry{TotalSectors: 134217728, SectorBytes: 512, FirstUsable: 34, LastUsable: 134217694, AlignSectors: 2048,
		Partitions: []GPTPartition{{1, 2048, 206847, "EF00"}, {2, 206848, 239615, "0C01"}, {3, 239616, 132120542, "0700"}, {4, 132120576, 134217694, "2700"}}}
	if !reflect.DeepEqual(g, want) {
		t.Fatalf("got %+v", g)
	}
	e, err := SgdiskPrint(fixture(t, "sgdisk-p-empty.txt"))
	if err != nil || !e.NewTable || len(e.Partitions) != 0 || e.LastUsable != 33554398 {
		t.Fatalf("empty = %+v, %v", e, err)
	}
	if _, err := SgdiskPrint("Problem opening /dev/nope for reading!"); err == nil {
		t.Fatal("garbage must be an error")
	}
}

func TestNTFSResize(t *testing.T) {
	clean := NTFSResize(fixture(t, "ntfsresize-info-clean.txt"))
	if clean != (NTFSInfo{VolumeBytes: 67523031552, MinBytes: 69636096, UsedBytes: 70_000_000}) {
		t.Errorf("clean = %+v", clean)
	}
	if d := NTFSResize(fixture(t, "ntfsresize-info-dirty.txt")); !d.Dirty || d.MinBytes != 0 {
		t.Errorf("dirty = %+v", d)
	}
	if b := NTFSResize(fixture(t, "ntfsresize-info-bitlocker.txt")); !b.NotNTFS || b.Dirty {
		t.Errorf("bitlocker = %+v", b)
	}
	if h := NTFSResize("Windows is hibernated, refused to mount."); !h.Hibernated {
		t.Errorf("hibernated = %+v", h)
	}
}

func TestEFIBool(t *testing.T) {
	on, err := EFIBool([]byte{6, 0, 0, 0, 1})
	off, _ := EFIBool([]byte{6, 0, 0, 0, 0})
	if err != nil || !on || off {
		t.Fatalf("on=%v off=%v err=%v", on, off, err)
	}
	if _, err := EFIBool([]byte{6, 0}); err == nil {
		t.Fatal("short var must be an error")
	}
}

func TestProcMountsAndSwaps(t *testing.T) {
	m := ProcMounts(fixture(t, "proc-mounts-live.txt"))
	if len(m) != 6 || m[2] != (Mount{"/dev/sdb1", "/run/live/medium", "iso9660"}) || m[5].Target != "/media/user/My Files" {
		t.Fatalf("mounts = %+v", m)
	}
	if s := ProcSwaps(fixture(t, "proc-swaps.txt")); !reflect.DeepEqual(s, []string{"/dev/zram0"}) {
		t.Fatalf("swaps = %v", s)
	}
}

func TestEFIBootMgr(t *testing.T) {
	got := EFIBootMgr(fixture(t, "efibootmgr.txt"))
	want := []EFIBootEntry{{"0000", "Windows Boot Manager"}, {"0001", "UEFI: USB Stick"}, {"0003", "Rafiq"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v", got)
	}
}

func TestPasswd(t *testing.T) {
	got := Passwd("root:x:0:0:root:/root:/bin/bash\nada:x:1000:1000:Ada Lovelace,,,:/home/ada:/bin/bash\nbroken\n")
	if len(got) != 2 || got[1] != (PasswdEntry{"ada", 1000, 1000, "/home/ada"}) {
		t.Fatalf("got %+v", got)
	}
}
