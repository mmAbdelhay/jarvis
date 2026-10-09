// Package img turns a wlr-screencopy shm buffer into the PNG jarvis-cu
// sends: format conversion, y-invert, blanking of everything that is not
// an allowed window, area-average downscale. Pure Go, no external deps.
package img

import (
	"bytes"
	"fmt"
	"image"
	"image/png"
	"math"
)

// Format is a wl_shm format code.
type Format uint32

// The 32-bit formats screencopy offers on labwc (pixman and GLES).
const (
	FormatARGB8888 Format = 0
	FormatXRGB8888 Format = 1
	FormatABGR8888 Format = 0x34324241
	FormatXBGR8888 Format = 0x34324258
)

// Supported reports whether RGBA can read the format.
func (f Format) Supported() bool {
	switch f {
	case FormatARGB8888, FormatXRGB8888, FormatABGR8888, FormatXBGR8888:
		return true
	}
	return false
}

const maxSide = 16384

// Frame is one copied output image.
type Frame struct {
	Width, Height, Stride int
	Format                Format
	YInvert               bool
	Pix                   []byte
}

// RGBA converts the frame to an opaque RGBA image.
func (f Frame) RGBA() (*image.RGBA, error) {
	if !f.Format.Supported() {
		return nil, fmt.Errorf("img: unsupported shm format 0x%x", uint32(f.Format))
	}
	if f.Width <= 0 || f.Height <= 0 || f.Width > maxSide || f.Height > maxSide {
		return nil, fmt.Errorf("img: odd frame size %dx%d", f.Width, f.Height)
	}
	if f.Stride < 4*f.Width || f.Stride > len(f.Pix)/f.Height {
		return nil, fmt.Errorf("img: frame buffer too small (stride %d, %d bytes)", f.Stride, len(f.Pix))
	}
	out := image.NewRGBA(image.Rect(0, 0, f.Width, f.Height))
	bgr := f.Format == FormatARGB8888 || f.Format == FormatXRGB8888
	for y := 0; y < f.Height; y++ {
		sy := y
		if f.YInvert {
			sy = f.Height - 1 - y
		}
		src := f.Pix[sy*f.Stride : sy*f.Stride+4*f.Width]
		dst := out.Pix[y*out.Stride : y*out.Stride+4*f.Width]
		for x := 0; x < 4*f.Width; x += 4 {
			if bgr {
				dst[x], dst[x+1], dst[x+2] = src[x+2], src[x+1], src[x]
			} else {
				dst[x], dst[x+1], dst[x+2] = src[x], src[x+1], src[x+2]
			}
			dst[x+3] = 0xff
		}
	}
	return out, nil
}

// Blank paints the whole image opaque black.
func Blank(m *image.RGBA) {
	b := m.Bounds()
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			i := m.PixOffset(x, y)
			m.Pix[i], m.Pix[i+1], m.Pix[i+2], m.Pix[i+3] = 0, 0, 0, 0xff
		}
	}
}

// Mask paints every pixel outside the union of keep opaque black.
func Mask(m *image.RGBA, keep []image.Rectangle) {
	b := m.Bounds()
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			p := image.Pt(x, y)
			in := false
			for _, r := range keep {
				if p.In(r) {
					in = true
					break
				}
			}
			if !in {
				i := m.PixOffset(x, y)
				m.Pix[i], m.Pix[i+1], m.Pix[i+2], m.Pix[i+3] = 0, 0, 0, 0xff
			}
		}
	}
}

// Downscale shrinks src so its longest edge is at most maxEdge (area
// average). It returns src itself and scale 1 when it already fits. The
// scale is dstWidth/srcWidth.
func Downscale(src *image.RGBA, maxEdge int) (*image.RGBA, float64) {
	w, h := src.Bounds().Dx(), src.Bounds().Dy()
	if maxEdge <= 0 || max(w, h) <= maxEdge {
		return src, 1
	}
	s := float64(maxEdge) / float64(max(w, h))
	dw := max(1, int(math.Round(float64(w)*s)))
	dh := max(1, int(math.Round(float64(h)*s)))
	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	// Use integer overlap weights in units of 1/dw and 1/dh source
	// pixels, so fractional coverage does not introduce rounding error.
	bounds := src.Bounds()
	for dy := 0; dy < dh; dy++ {
		y0, y1 := dy*h, (dy+1)*h
		for dx := 0; dx < dw; dx++ {
			x0, x1 := dx*w, (dx+1)*w
			var r, g, b, area uint64
			for y := y0 / dh; y < (y1+dh-1)/dh; y++ {
				wy := min(y1, (y+1)*dh) - max(y0, y*dh)
				for x := x0 / dw; x < (x1+dw-1)/dw; x++ {
					wx := min(x1, (x+1)*dw) - max(x0, x*dw)
					weight := uint64(wx) * uint64(wy)
					i := src.PixOffset(bounds.Min.X+x, bounds.Min.Y+y)
					r += uint64(src.Pix[i]) * weight
					g += uint64(src.Pix[i+1]) * weight
					b += uint64(src.Pix[i+2]) * weight
					area += weight
				}
			}
			i := dst.PixOffset(dx, dy)
			dst.Pix[i], dst.Pix[i+1], dst.Pix[i+2], dst.Pix[i+3] = uint8(r/area), uint8(g/area), uint8(b/area), 0xff
		}
	}
	return dst, float64(dw) / float64(w)
}

// EncodePNG encodes quickly (screenshots are sent, not archived).
func EncodePNG(m *image.RGBA) ([]byte, error) {
	var buf bytes.Buffer
	enc := png.Encoder{CompressionLevel: png.BestSpeed}
	if err := enc.Encode(&buf, m); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
