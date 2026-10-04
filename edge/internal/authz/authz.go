// Package authz implements the agent's bearer-token authentication.
//
// Why this package exists at all: the JavaScript agent this replaces
// (vercel-leg/termux/server.js) had NO authentication of any kind on an
// endpoint that ran arbitrary shell commands, while binding 0.0.0.0 and
// being published to the public internet through a `cloudflared tunnel
// --url` quick tunnel. That is unauthenticated remote code execution.
//
// Two properties matter and are both tested:
//
//  1. Fail-closed. With no token configured the server refuses every
//     request. There is no "development mode" that silently disables auth,
//     because that is exactly how the previous agent ended up exposed.
//  2. Constant-time comparison, so a token cannot be recovered by timing
//     the rejection.
package authz

import (
	"crypto/subtle"
	"errors"
	"net/http"
	"strings"
)

// ErrNoToken is returned by New when no token was supplied. It is a
// configuration error and the caller is expected to refuse to start.
var ErrNoToken = errors.New("authz: no token configured")

// Authenticator validates bearer tokens.
type Authenticator struct {
	token string
}

// New builds an Authenticator. It returns ErrNoToken when token is blank,
// so a missing token can never be mistaken for "auth disabled".
func New(token string) (*Authenticator, error) {
	t := strings.TrimSpace(token)
	if t == "" {
		return nil, ErrNoToken
	}
	return &Authenticator{token: t}, nil
}

// Authorized reports whether r carries the configured token.
//
// Accepts either `Authorization: Bearer <token>` or `X-Device-Key: <token>`,
// because the existing device bridge (vercel-leg/api/device_gateway.py) and
// its long-poll client already speak X-Device-Key. Keeping both means the
// Go agent drops into the existing protocol without a coordinated change on
// the cloud side.
func (a *Authenticator) Authorized(r *http.Request) bool {
	if a == nil || a.token == "" {
		return false
	}
	presented := presentedToken(r)
	if presented == "" {
		return false
	}
	// subtle.ConstantTimeCompare returns 0 for differing lengths, which is
	// itself a length signal; hash both sides first so the comparison is
	// over equal-length values.
	want := sha256Hex(a.token)
	got := sha256Hex(presented)
	return subtle.ConstantTimeCompare([]byte(want), []byte(got)) == 1
}

func presentedToken(r *http.Request) string {
	// NOTE: the presented value is deliberately NOT trimmed. Go's HTTP server
	// already strips optional whitespace from header values, so trimming here
	// would only widen the accepted set: " secret" would authenticate as
	// "secret". An exact match is the intent.
	if h := r.Header.Get("Authorization"); h != "" {
		if after, ok := cutPrefixFold(h, "Bearer "); ok {
			return after
		}
		// A bare Authorization header is accepted too: some minimal HTTP
		// clients cannot be configured to add a scheme.
		if !strings.Contains(h, " ") {
			return h
		}
	}
	return r.Header.Get("X-Device-Key")
}

func cutPrefixFold(s, prefix string) (string, bool) {
	if len(s) < len(prefix) {
		return "", false
	}
	if !strings.EqualFold(s[:len(prefix)], prefix) {
		return "", false
	}
	return s[len(prefix):], true
}
