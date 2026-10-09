// Package install is the Rafiq installer backend (M2 design §5.2,
// contracts §1): Probe reads the machine, Plan turns the user's choices into
// an exact, reviewable InstallPlan with no side effects, and Execute runs
// that plan through execx with secrets on stdin only.
package install

import (
	"bytes"
	"encoding/json"
	"fmt"

	"github.com/mmAbdelhay/jarvis/os/go/internal/catalog"
)

// NTFSState is what the probe found about an NTFS (or BitLocker) partition.
// MinSizeBytes is the smallest size Windows may be shrunk to: ntfsresize's
// minimum plus WindowsHeadroomBytes, rounded up to 1 MB, never more than
// the partition (then it cannot shrink at all).
type NTFSState struct {
	Dirty        bool  `json:"dirty"`
	Hibernated   bool  `json:"hibernated"`
	Bitlocker    bool  `json:"bitlocker"`
	MinSizeBytes int64 `json:"minSizeBytes"`
}

// Partition is one partition. Fields tagged "-" stay in the backend: the
// plan needs exact sectors and GPT identity, the UI does not.
type Partition struct {
	Path      string     `json:"path"`
	FS        string     `json:"fs"`
	Label     string     `json:"label"`
	SizeBytes int64      `json:"sizeBytes"`
	UsedBytes *int64     `json:"usedBytes"`
	NTFS      *NTFSState `json:"ntfs,omitempty"`

	Number     int    `json:"-"`
	Start, End int64  `json:"-"` // sectors, inclusive
	TypeGUID   string `json:"-"` // lower case
	UniqueGUID string `json:"-"`
	Name       string `json:"-"` // GPT partition name
	Flags      uint64 `json:"-"` // GPT attribute bits
}

// Disk is one installable disk (contracts §1 Disk).
type Disk struct {
	Path             string           `json:"path"`
	Model            string           `json:"model"`
	SizeBytes        int64            `json:"sizeBytes"`
	Removable        bool             `json:"removable"`
	Partitions       []Partition      `json:"partitions"`
	ESP              *string          `json:"esp"`
	WindowsPartition *string          `json:"windowsPartition"`
	AlongsideBounds  *AlongsideBounds `json:"alongsideBounds"`

	GPT         bool  `json:"-"` // a valid GPT is on the disk
	SectorBytes int64 `json:"-"`
	FirstUsable int64 `json:"-"`
	LastUsable  int64 `json:"-"`
}

type AlongsideBounds struct {
	MinBytes int64 `json:"minBytes"`
	MaxBytes int64 `json:"maxBytes"`
}

// ProbeModel adds the backend-computed fit result to a catalog entry.
type ProbeModel struct {
	catalog.Model
	Fits bool `json:"fits"`
}

// GPU is the first display controller found.
type GPU struct {
	Name      string `json:"name"`
	VRAMBytes *int64 `json:"vramBytes"`
}

// ProbeResult is contracts §1 ProbeResult.
type ProbeResult struct {
	UEFI        bool         `json:"uefi"`
	SecureBoot  bool         `json:"secureBoot"`
	RAMBytes    int64        `json:"ramBytes"`
	GPU         *GPU         `json:"gpu"`
	Online      bool         `json:"online"`
	Disks       []Disk       `json:"disks"`
	GeoTimezone *string      `json:"geoTimezone"`
	Catalog     []ProbeModel `json:"catalog"`
	// LiveDevice is the disk the live ISO booted from (findmnt of
	// /run/live/medium); Plan refuses it with "live-medium".
	LiveDevice *string `json:"liveDevice"`
	// MinRootBytes is the smallest Rafiq partition; the UI and Plan
	// share this one number (MinRootBytes).
	MinRootBytes int64 `json:"minRootBytes"`
}

// ManualEntry is one row of the Manual table editor.
type ManualEntry struct {
	Partition string `json:"partition"`
	Mount     string `json:"mount"` // "/" | "/boot" | "/boot/efi" | "swap"
	Format    bool   `json:"format"`
}

// DiskChoice is Choices.disk.
type DiskChoice struct {
	Path               string        `json:"path"`
	Mode               string        `json:"mode"` // "erase" | "alongside" | "manual"
	AlongsideSizeBytes *int64        `json:"alongsideSizeBytes,omitempty"`
	Manual             []ManualEntry `json:"manual,omitempty"`
}

// UserChoice is Choices.user.
type UserChoice struct {
	FullName  string `json:"fullName"`
	Username  string `json:"username"`
	Hostname  string `json:"hostname"`
	Autologin bool   `json:"autologin"`
}

// Brain is the tagged union Choices.brain.
type Brain struct {
	Kind    string `json:"kind"`              // "local" | "cloud" | "lan"
	ModelID string `json:"modelId,omitempty"` // local
	BaseURL string `json:"baseUrl,omitempty"` // lan
	Model   string `json:"model,omitempty"`   // lan
}

// UnmarshalJSON decodes the variant named by kind and refuses fields that
// belong to another variant.
func (b *Brain) UnmarshalJSON(raw []byte) error {
	var head struct {
		Kind string `json:"kind"`
	}
	if err := json.Unmarshal(raw, &head); err != nil {
		return err
	}
	var err error
	switch head.Kind {
	case "local":
		var v struct {
			Kind    string `json:"kind"`
			ModelID string `json:"modelId"`
		}
		err = strict(raw, &v, "kind", "modelId")
		*b = Brain{Kind: v.Kind, ModelID: v.ModelID}
	case "cloud":
		var v struct {
			Kind string `json:"kind"`
		}
		err = strict(raw, &v, "kind")
		*b = Brain{Kind: v.Kind}
	case "lan":
		var v struct {
			Kind    string `json:"kind"`
			BaseURL string `json:"baseUrl"`
			Model   string `json:"model"`
		}
		err = strict(raw, &v, "kind", "baseUrl", "model")
		*b = Brain{Kind: v.Kind, BaseURL: v.BaseURL, Model: v.Model}
	default:
		return invalidf("%s", text.InvalidBrainKind)
	}
	return err
}

// Choices is contracts §1 Choices.
type Choices struct {
	Locale   string     `json:"locale"`
	Keyboard string     `json:"keyboard"`
	Timezone string     `json:"timezone"`
	Disk     DiskChoice `json:"disk"`
	Encrypt  bool       `json:"encrypt"`
	User     UserChoice `json:"user"`
	Brain    Brain      `json:"brain"`
}

// Step is one InstallPlan step.
type Step struct {
	StepID string `json:"stepId"`
	Title  string `json:"title"`
}

// DiskAfter is one row of the "disk after install" picture.
type DiskAfter struct {
	Label     string `json:"label"`
	SizeBytes int64  `json:"sizeBytes"`
	Encrypted bool   `json:"encrypted"`
}

// InstallPlan is contracts §1 InstallPlan, rendered verbatim on Review.
type InstallPlan struct {
	PlanID    string      `json:"planId"`
	Summary   []string    `json:"summary"`
	Steps     []Step      `json:"steps"`
	DiskAfter []DiskAfter `json:"diskAfter"`
	Warnings  []string    `json:"warnings"`
}

// Secrets is contracts §1 secretsJson. Never logged, never in a plan, never
// in argv.
type Secrets struct {
	UserPassword   string  `json:"userPassword"`
	LUKSPassphrase *string `json:"luksPassphrase"`
}

// strict decodes raw into dst refusing unknown fields, after checking that
// every field in required is present.
func strict(raw []byte, dst any, required ...string) error {
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(raw, &keys); err != nil {
		return err
	}
	for _, k := range required {
		if value, ok := keys[k]; !ok || (k != "luksPassphrase" && bytes.Equal(bytes.TrimSpace(value), []byte("null"))) {
			return fmt.Errorf("missing field %q", k)
		}
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return err
	}
	if dec.More() {
		return fmt.Errorf("trailing data")
	}
	return nil
}

// DecodeChoices parses the UI's JSON field by field. Every top-level and
// user field is required (a missing "encrypt" must not silently mean
// "no encryption").
func DecodeChoices(raw []byte) (Choices, error) {
	var c Choices
	if err := strict(raw, &c, "locale", "keyboard", "timezone", "disk", "encrypt", "user", "brain"); err != nil {
		return c, invalidf(text.ChoicesDecode, err)
	}
	var top struct {
		Disk json.RawMessage `json:"disk"`
		User json.RawMessage `json:"user"`
	}
	_ = json.Unmarshal(raw, &top)
	if err := strict(top.Disk, &DiskChoice{}, "path", "mode"); err != nil {
		return c, invalidf(text.DiskDecode, err)
	}
	if err := strict(top.User, &UserChoice{}, "fullName", "username", "hostname", "autologin"); err != nil {
		return c, invalidf(text.UserDecode, err)
	}
	return c, nil
}

// DecodeSecrets parses secretsJson.
func DecodeSecrets(raw []byte) (Secrets, error) {
	var s Secrets
	if err := strict(raw, &s, "userPassword", "luksPassphrase"); err != nil {
		return s, invalidf("%s", text.SecretsDecode)
	}
	return s, nil
}

// Refusal is a plan the backend will not make; Key is one of the contract
// refusal keys and leads the D-Bus error message ("<key>: <reason>").
type Refusal struct {
	Key    string
	Reason string
}

func (r *Refusal) Error() string { return r.Key + ": " + r.Reason }

// InvalidError is malformed input (a bad username, an unknown disk).
type InvalidError struct{ Msg string }

func (e *InvalidError) Error() string { return e.Msg }

func invalidf(format string, a ...any) error {
	return &InvalidError{Msg: fmt.Sprintf(format, a...)}
}

// Refusal keys (contracts §1; alongside-no-windows is proposed by Plan F).
const (
	RefuseNoUEFI          = "no-uefi"
	RefuseDiskTooSmall    = "disk-too-small"
	RefuseNTFSBitlocker   = "ntfs-bitlocker"
	RefuseNTFSHibernated  = "ntfs-hibernated"
	RefuseNTFSDirty       = "ntfs-dirty"
	RefuseAlongsideSmall  = "alongside-too-small"
	RefuseManualNoRoot    = "manual-missing-root"
	RefuseManualNoESP     = "manual-missing-esp"
	RefuseManualNoBoot    = "manual-missing-boot" // encrypted manual install without a separate /boot (M2 contracts §12)
	RefuseModelDoesNotFit = "model-does-not-fit"
	RefuseAlongsideNoWin  = "alongside-no-windows"
	RefuseLiveMedium      = "live-medium"
)
