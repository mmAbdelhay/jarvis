package catalog

import (
	"testing"

	"github.com/mmAbdelhay/jarvis/os/go/internal/files"
)

const doc = `{"version":1,"future":"ignored","models":[
 {"id":"qwen3-8b","ollamaTag":"qwen3:8b","displayName":"Qwen3 8B","sizeBytes":5200000000,"minRamGB":16,"minVramGB":null,"tier":"medium","toolCalling":"verified","languages":["en","ar"],"recommendedFor":"Most laptops with 16 GB","newField":1},
 {"id":"qwen3-8b","ollamaTag":"qwen3:8b-dup","displayName":"dup","sizeBytes":1,"minRamGB":1,"tier":"small","toolCalling":"verified","languages":[],"recommendedFor":""},
 {"id":"bad tag","ollamaTag":"qwen3:8b; rm -rf /","displayName":"x","sizeBytes":1,"minRamGB":1,"tier":"small","toolCalling":"verified","languages":[],"recommendedFor":""},
 {"id":"unverified","ollamaTag":"x:1","displayName":"x","sizeBytes":1,"minRamGB":1,"tier":"small","toolCalling":"untested","languages":[],"recommendedFor":""},
 {"id":"gpu-32b","ollamaTag":"qwen3:32b","displayName":"Qwen3 32B","sizeBytes":20000000000,"minRamGB":32,"minVramGB":24,"tier":"gpu","toolCalling":"verified","recommendedFor":"NVIDIA 24 GB"}
]}`

func TestParseKeepsValidEntriesOnly(t *testing.T) {
	ms, err := Parse([]byte(doc))
	if err != nil {
		t.Fatal(err)
	}
	if len(ms) != 2 || ms[0].ID != "qwen3-8b" || ms[0].OllamaTag != "qwen3:8b" || ms[1].ID != "gpu-32b" || *ms[1].MinVramGB != 24 {
		t.Fatalf("got %+v", ms)
	}
	if ms[1].Languages == nil {
		t.Fatal("languages must be [] not null on the wire")
	}
	if _, ok := Find(ms, "gpu-32b"); !ok {
		t.Fatal("Find")
	}
	if _, err := Parse([]byte(`{"version":0,"models":[]}`)); err == nil {
		t.Fatal("version 0 must be refused")
	}
}

func TestLoadMissingIsEmpty(t *testing.T) {
	ms, err := Load(&files.OS{Root: t.TempDir()}, Path)
	if err != nil || ms == nil || len(ms) != 0 {
		t.Fatalf("got %v, %v", ms, err)
	}
}

// Contracts §6.12: installer and catalog UIs hide role == "backup"; role
// defaults to main. The backup is jarvisd's, never a brain to pick.
func TestParseHidesTheBackupModel(t *testing.T) {
	ms, err := Parse([]byte(`{"version":1,"models":[
 {"id":"qwen3-1.7b","ollamaTag":"qwen3:1.7b","displayName":"Qwen3 1.7B","sizeBytes":1359293444,"minRamGB":4,"minVramGB":null,"tier":"small","toolCalling":"verified","languages":["en","ar"],"recommendedFor":"backup","role":"backup"},
 {"id":"llama3.2-3b","ollamaTag":"llama3.2:3b","displayName":"Llama 3.2 3B","sizeBytes":2019393189,"minRamGB":8,"minVramGB":null,"tier":"small","toolCalling":"verified","languages":["en"],"recommendedFor":"8 GB","role":"main"},
 {"id":"no-role","ollamaTag":"x:1","displayName":"x","sizeBytes":1,"minRamGB":1,"tier":"small","toolCalling":"verified","languages":[],"recommendedFor":""},
 {"id":"odd-role","ollamaTag":"y:1","displayName":"y","sizeBytes":1,"minRamGB":1,"tier":"small","toolCalling":"verified","languages":[],"recommendedFor":"","role":"spare"}
]}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(ms) != 2 || ms[0].ID != "llama3.2-3b" || ms[0].Role != "main" || ms[1].ID != "no-role" {
		t.Fatalf("got %+v", ms)
	}
	if _, ok := Find(ms, "qwen3-1.7b"); ok {
		t.Fatal("the backup must not be offered")
	}
}

// The shipped catalog: its backup entry never reaches the installer.
func TestShippedCatalogOffersNoBackup(t *testing.T) {
	ms, err := Load(&files.OS{Root: "../../../models"}, "/catalog.json")
	if err != nil || len(ms) == 0 {
		t.Fatalf("got %v, %v", ms, err)
	}
	for _, m := range ms {
		if m.Role == "backup" || m.ID == "qwen3-1.7b" {
			t.Fatalf("backup offered: %+v", m)
		}
	}
}
