package parse

import (
	"reflect"
	"testing"
)

func TestDf(t *testing.T) {
	got := Df(fixture(t, "df.txt"))
	if len(got) != 5 {
		t.Fatalf("got %d rows: %+v", len(got), got)
	}
	if got[0] != (Filesystem{"/", 4123459584, 987654144}) {
		t.Errorf("root = %+v", got[0])
	}
	if got[1].Mount != "/run/live/medium" {
		t.Errorf("full fs mount = %+v", got[1])
	}
	if got[3].Mount != "/media/jarvis/USB DISK" || got[3].UsedBytes != 2147483648 {
		t.Errorf("mount with a space = %+v", got[3])
	}
}

func TestDu(t *testing.T) {
	out := "4096\t/home/jarvis/.config\n1073741824\t/home/jarvis/Videos\n52428800\t/home/jarvis/.cache\n1126174720\t/home/jarvis\n"
	got := Du(out, "/home/jarvis/", 2)
	want := []DirSize{{"/home/jarvis/Videos", 1073741824}, {"/home/jarvis/.cache", 52428800}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v", got)
	}
	if len(Du("du: cannot read directory '/home/jarvis/x': Permission denied\n", "/home/jarvis", 10)) != 0 {
		t.Fatal("error lines must be skipped")
	}
}

func TestProcFiles(t *testing.T) {
	if up, err := Uptime("3605.27 7012.40\n"); err != nil || up != 3605 {
		t.Errorf("Uptime = %d, %v", up, err)
	}
	if l, err := Load1("0.42 0.30 0.25 1/312 4242\n"); err != nil || l != 0.42 {
		t.Errorf("Load1 = %v, %v", l, err)
	}
	m, err := MemInfo(fixture(t, "proc-meminfo.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if m.TotalBytes != 4014560*1024 || m.UsedBytes() != (4014560-3301456)*1024 || m.SwapUsedBytes() != (2097148-1835004)*1024 {
		t.Fatalf("got %+v", m)
	}
	if _, err := MemInfo("garbage"); err == nil {
		t.Fatal("garbage meminfo accepted")
	}
}
