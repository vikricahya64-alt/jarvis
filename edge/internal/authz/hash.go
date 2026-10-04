package authz

import (
	"crypto/sha256"
	"encoding/hex"
)

// sha256Hex lets the token comparison run over fixed-length digests, so
// ConstantTimeCompare cannot leak the token's length through its early
// return on mismatched lengths.
func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}
