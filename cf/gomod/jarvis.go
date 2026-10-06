// Pure text helpers ported from cf/src/lib to be callable from Go.
//
// The point of this package is NOT to replace the TypeScript implementation.
// It is to give the CPU-bound parts a native implementation while
// jarvis.go's parity tests guarantee the two produce byte-identical output.
// If a parity test fails, the TS version is the source of truth and this file
// is the bug.
package gomod

import (
	"strings"

	"golang.org/x/text/unicode/norm"
)

// combining marks that cf/src/lib/moderation.ts strips with /[\u0300-\u036f]/g
func isCombiningMark(r rune) bool { return r >= 0x0300 && r <= 0x036F }

// Normalize is byte-for-byte equivalent to normalize() in
// cf/src/lib/moderation.ts:
//
//	s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
//
// The order is part of the contract: lowercase happens BEFORE NFD. Reversing
// it is not equivalent for every input, so do not "tidy" it.
func Normalize(s string) string {
	decomposed := norm.NFD.String(strings.ToLower(s))
	var b strings.Builder
	b.Grow(len(decomposed))
	for _, r := range decomposed {
		if !isCombiningMark(r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// NormalizeLink is byte-for-byte equivalent to normalizeLinkForCompare() in
// cf/src/lib/verifier.ts:
//
//	url.trim()
//	   .replace(/^https?:\/\//i, "")
//	   .replace(/^www\./i, "")
//	   .split(/[?#]/)[0]
//	   .replace(/\/+$/, "")
//	   .toLowerCase()
func NormalizeLink(u string) string {
	s := strings.TrimSpace(u)
	lower := strings.ToLower(s)
	switch {
	case strings.HasPrefix(lower, "http://"):
		s = s[len("http://"):]
	case strings.HasPrefix(lower, "https://"):
		s = s[len("https://"):]
	}
	if strings.HasPrefix(strings.ToLower(s), "www.") {
		s = s[len("www."):]
	}
	if i := strings.IndexAny(s, "?#"); i >= 0 {
		s = s[:i]
	}
	return strings.ToLower(strings.TrimRight(s, "/"))
}
