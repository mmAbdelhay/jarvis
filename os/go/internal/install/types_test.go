package install

import (
	"encoding/json"
	"strings"
	"testing"
)

// Pointer helpers shared by the package's tests.
func i64(n int64) *int64   { return &n }
func str(s string) *string { return &s }

func TestDecodeChoicesStrict(t *testing.T) {
	good := `{"locale":"en_US.UTF-8","keyboard":"us","timezone":"Africa/Cairo","disk":{"path":"/dev/sda","mode":"erase"},"encrypt":true,` +
		`"user":{"fullName":"Ada","username":"ada","hostname":"ada-pc","autologin":false},"brain":{"kind":"local","modelId":"small-4b"}}`
	c, err := DecodeChoices([]byte(good))
	if err != nil || c.Brain.ModelID != "small-4b" || !c.Encrypt {
		t.Fatalf("got %+v, %v", c, err)
	}
	for name, bad := range map[string]string{
		"missing encrypt":    strings.Replace(good, `"encrypt":true,`, "", 1),
		"missing autologin":  strings.Replace(good, `,"autologin":false`, "", 1),
		"unknown field":      strings.Replace(good, `"encrypt":true`, `"encrypt":true,"shell":"rm -rf /"`, 1),
		"unknown disk field": strings.Replace(good, `"mode":"erase"`, `"mode":"erase","force":true`, 1),
		"brain cross field":  strings.Replace(good, `"modelId":"small-4b"`, `"modelId":"small-4b","baseUrl":"http://x"`, 1),
		"brain bad kind":     strings.Replace(good, `"kind":"local"`, `"kind":"remote"`, 1),
		"lan missing model":  strings.Replace(good, `{"kind":"local","modelId":"small-4b"}`, `{"kind":"lan","baseUrl":"http://x:11434"}`, 1),
		"not json":           `{`,
	} {
		if _, err := DecodeChoices([]byte(bad)); err == nil {
			t.Errorf("%s: accepted", name)
		} else if _, ok := err.(*InvalidError); !ok {
			t.Errorf("%s: %T, want *InvalidError", name, err)
		}
	}
}

func TestSecretsRules(t *testing.T) {
	s, err := DecodeSecrets([]byte(`{"userPassword":"pw","luksPassphrase":null}`))
	if err != nil || s.LUKSPassphrase != nil {
		t.Fatalf("%+v %v", s, err)
	}
	if _, err := DecodeSecrets([]byte(`{"userPassword":"pw"}`)); err == nil {
		t.Fatal("luksPassphrase must be present (null when not encrypting)")
	}
	if err := checkSecrets(Secrets{UserPassword: "pw", LUKSPassphrase: str("correct horse")}, true); err != nil {
		t.Fatal(err)
	}
	for name, s := range map[string]struct {
		sec Secrets
		enc bool
	}{
		"empty password":         {Secrets{UserPassword: ""}, false},
		"newline in password":    {Secrets{UserPassword: "a\nroot:x"}, false},
		"missing passphrase":     {Secrets{UserPassword: "pw"}, true},
		"passphrase without enc": {Secrets{UserPassword: "pw", LUKSPassphrase: str("correct horse")}, false},
		"short passphrase":       {Secrets{UserPassword: "pw", LUKSPassphrase: str("short")}, true},
		"newline in passphrase":  {Secrets{UserPassword: "pw", LUKSPassphrase: str("correct horse\n")}, true},
	} {
		if err := checkSecrets(s.sec, s.enc); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestRequiredFieldsRejectNull(t *testing.T) {
	good := `{"locale":"en_US.UTF-8","keyboard":"us","timezone":"Africa/Cairo","disk":{"path":"/dev/sda","mode":"erase"},"encrypt":true,"user":{"fullName":"Ada","username":"ada","hostname":"ada-pc","autologin":false},"brain":{"kind":"cloud"}}`
	for _, pair := range [][2]string{{`"encrypt":true`, `"encrypt":null`}, {`"autologin":false`, `"autologin":null`}} {
		if _, err := DecodeChoices([]byte(strings.Replace(good, pair[0], pair[1], 1))); err == nil {
			t.Errorf("accepted %s", pair[1])
		}
	}
	if _, err := DecodeSecrets([]byte(`{"userPassword":null,"luksPassphrase":null}`)); err == nil {
		t.Error("accepted null password")
	}
}

func TestSecretCharacterLimits(t *testing.T) {
	for _, n := range []int{8, 512} {
		p := strings.Repeat("é", n)
		if err := checkSecrets(Secrets{UserPassword: strings.Repeat("é", 1024), LUKSPassphrase: &p}, true); err != nil {
			t.Errorf("%d characters: %v", n, err)
		}
	}
	p := strings.Repeat("é", 7)
	if err := checkSecrets(Secrets{UserPassword: "pw", LUKSPassphrase: &p}, true); err == nil {
		t.Error("accepted seven-character passphrase")
	}
}

func TestProbeWireResolutions(t *testing.T) {
	raw, err := json.Marshal(ProbeResult{Disks: []Disk{{}}, Catalog: []ProbeModel{{Fits: true}}})
	if err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{`"windowsPartition":null`, `"alongsideBounds":null`, `"fits":true`} {
		if !strings.Contains(string(raw), field) {
			t.Errorf("missing %s in %s", field, raw)
		}
	}
}
