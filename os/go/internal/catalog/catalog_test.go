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
