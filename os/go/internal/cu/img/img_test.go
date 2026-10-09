package img

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"testing"
)

func TestRGBAFormats(t *testing.T) {
	// One pixel, memory order of each 32-bit little-endian format.
	cases := map[Format][4]byte{
		FormatXRGB8888: {0x30, 0x20, 0x10, 0x00}, // B G R X
		FormatARGB8888: {0x30, 0x20, 0x10, 0x80}, // B G R A
		FormatXBGR8888: {0x10, 0x20, 0x30, 0x00}, // R G B X
		FormatABGR8888: {0x10, 0x20, 0x30, 0x80}, // R G B A
	}
	for f, px := range cases {
		m, err := Frame{Width: 1, Height: 1, Stride: 4, Format: f, Pix: px[:]}.RGBA()
		if err != nil {
			t.Fatalf("%x: %v", f, err)
		}
		if got := m.RGBAAt(0, 0); got != (color.RGBA{0x10, 0x20, 0x30, 0xff}) {
			t.Errorf("format %x: got %v", f, got)
		}
	}
}

func TestRGBAYInvertAndStride(t *testing.T) {
	// 1x2 image, stride 8 (4 bytes padding per row).
	pix := []byte{
		0, 0, 0xff, 0, 9, 9, 9, 9, // row 0: red
		0xff, 0, 0, 0, 9, 9, 9, 9, // row 1: blue
	}
	m, err := Frame{Width: 1, Height: 2, Stride: 8, Format: FormatXRGB8888, YInvert: true, Pix: pix}.RGBA()
	if err != nil {
		t.Fatal(err)
	}
	if m.RGBAAt(0, 0) != (color.RGBA{0, 0, 0xff, 0xff}) || m.RGBAAt(0, 1) != (color.RGBA{0xff, 0, 0, 0xff}) {
		t.Fatalf("y-invert not applied: %v %v", m.RGBAAt(0, 0), m.RGBAAt(0, 1))
	}
}

func TestRGBARejectsBadFrames(t *testing.T) {
	bad := []Frame{
		{Width: 1, Height: 1, Stride: 4, Format: 0x1234, Pix: make([]byte, 4)},
		{Width: 0, Height: 1, Stride: 4, Format: FormatXRGB8888, Pix: make([]byte, 4)},
		{Width: 2, Height: 1, Stride: 4, Format: FormatXRGB8888, Pix: make([]byte, 8)},
		{Width: 1, Height: 2, Stride: 4, Format: FormatXRGB8888, Pix: make([]byte, 4)},
		{Width: 20000, Height: 1, Stride: 80000, Format: FormatXRGB8888, Pix: make([]byte, 80000)},
	}
	for i, f := range bad {
		if _, err := f.RGBA(); err == nil {
			t.Errorf("frame %d accepted", i)
		}
	}
}

func fill(w, h int, c color.RGBA) *image.RGBA {
	m := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			m.SetRGBA(x, y, c)
		}
	}
	return m
}

func TestBlankAndMask(t *testing.T) {
	white := color.RGBA{255, 255, 255, 255}
	black := color.RGBA{0, 0, 0, 255}
	m := fill(4, 4, white)
	Mask(m, []image.Rectangle{image.Rect(1, 1, 3, 3)})
	for y := 0; y < 4; y++ {
		for x := 0; x < 4; x++ {
			in := x >= 1 && x < 3 && y >= 1 && y < 3
			want := black
			if in {
				want = white
			}
			if m.RGBAAt(x, y) != want {
				t.Fatalf("(%d,%d) = %v", x, y, m.RGBAAt(x, y))
			}
		}
	}
	Blank(m)
	if m.RGBAAt(1, 1) != black {
		t.Fatal("Blank left a pixel")
	}
}

func TestDownscale(t *testing.T) {
	src := fill(2560, 1440, color.RGBA{100, 150, 200, 255})
	src.SetRGBA(0, 0, color.RGBA{0, 0, 0, 255})
	dst, scale := Downscale(src, 1280)
	if dst.Bounds().Dx() != 1280 || dst.Bounds().Dy() != 720 || scale != 0.5 {
		t.Fatalf("got %v scale %v", dst.Bounds(), scale)
	}
	// Top-left output pixel averages 4 inputs: one black, three coloured.
	if got := dst.RGBAAt(0, 0); got != (color.RGBA{75, 112, 150, 255}) {
		t.Fatalf("area average: %v", got)
	}
	same, s := Downscale(fill(800, 600, color.RGBA{}), 1280)
	if same.Bounds().Dx() != 800 || s != 1 {
		t.Fatal("an image that fits must be returned as is")
	}
}

func TestEncodePNGRoundTrip(t *testing.T) {
	m := fill(3, 2, color.RGBA{1, 2, 3, 255})
	b, err := EncodePNG(m)
	if err != nil {
		t.Fatal(err)
	}
	back, err := png.Decode(bytes.NewReader(b))
	if err != nil || back.Bounds().Dx() != 3 {
		t.Fatalf("%v %v", back, err)
	}
	r, g, bb, _ := back.At(2, 1).RGBA()
	if r>>8 != 1 || g>>8 != 2 || bb>>8 != 3 {
		t.Fatal("pixel changed")
	}
}

func TestRGBARejectsOverflowingStride(t *testing.T) {
	f := Frame{Width: 1, Height: 2, Stride: int(^uint(0) >> 1), Format: FormatXRGB8888, Pix: make([]byte, 4)}
	if _, err := f.RGBA(); err == nil {
		t.Fatal("overflowing stride accepted")
	}
}

func TestBlankSubimage(t *testing.T) {
	white := color.RGBA{255, 255, 255, 255}
	parent := fill(4, 4, white)
	Blank(parent.SubImage(image.Rect(1, 1, 3, 3)).(*image.RGBA))
	for y := 0; y < 4; y++ {
		for x := 0; x < 4; x++ {
			want := white
			if image.Pt(x, y).In(image.Rect(1, 1, 3, 3)) {
				want = color.RGBA{0, 0, 0, 255}
			}
			if got := parent.RGBAAt(x, y); got != want {
				t.Fatalf("(%d,%d): got %v, want %v", x, y, got, want)
			}
		}
	}
}

func TestDownscaleFractionalAreaAndSubimage(t *testing.T) {
	parent := fill(5, 3, color.RGBA{255, 0, 0, 255})
	src := parent.SubImage(image.Rect(1, 1, 4, 2)).(*image.RGBA)
	src.SetRGBA(1, 1, color.RGBA{0, 0, 0, 255})
	src.SetRGBA(2, 1, color.RGBA{90, 0, 0, 255})
	src.SetRGBA(3, 1, color.RGBA{180, 0, 0, 255})
	dst, scale := Downscale(src, 2)
	if dst.Bounds() != image.Rect(0, 0, 2, 1) || scale != 2.0/3.0 {
		t.Fatalf("bounds %v, scale %v", dst.Bounds(), scale)
	}
	for x, red := range []uint8{30, 150} {
		if got := dst.RGBAAt(x, 0); got != (color.RGBA{red, 0, 0, 255}) {
			t.Fatalf("pixel %d: %v, want red %d", x, got, red)
		}
	}
	if same, s := Downscale(src, 4); same != src || s != 1 {
		t.Fatal("fitting image was copied")
	}
}
