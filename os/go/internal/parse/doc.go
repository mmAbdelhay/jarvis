// Package parse turns command output into typed values. Every function is
// pure (text in, values out) and is tested against fixture files in
// testdata/ that reproduce Debian 13 output; testdata/CAPTURE.md lists the
// exact command behind each fixture so it can be re-captured on a real
// machine. Parsers are lenient: a line they do not understand is skipped,
// never fatal, because a newer tool version adding a column must not take a
// diagnosis tool down.
package parse
