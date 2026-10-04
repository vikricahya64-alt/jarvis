package authz

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestNewRejectsBlankToken(t *testing.T) {
	for _, blank := range []string{"", "   ", "\t", "\n"} {
		if _, err := New(blank); err == nil {
			t.Errorf("New(%q) accepted a blank token", blank)
		}
	}
	// A token that is only whitespace must NOT be treated as valid.
	if a, err := New("   "); err == nil && a.Authorized(httptest.NewRequest("GET", "/", nil)) {
		t.Error("whitespace token authorized a request")
	}
}

func TestAuthorized(t *testing.T) {
	a, err := New("tok-123")
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name  string
		build func() *http.Request
		want  bool
	}{
		{"bearer", req("Authorization", "Bearer tok-123"), true},
		{"bearer lowercase scheme", req("Authorization", "bearer tok-123"), true},
		{"bearer uppercase scheme", req("Authorization", "BEARER tok-123"), true},
		{"device key header", req("X-Device-Key", "tok-123"), true},
		{"bare authorization", req("Authorization", "tok-123"), true},
		{"no header", func() *http.Request { return httptest.NewRequest("GET", "/", nil) }, false},
		{"empty bearer", req("Authorization", "Bearer "), false},
		{"wrong token", req("Authorization", "Bearer nope"), false},
		{"case changed token", req("Authorization", "Bearer TOK-123"), false},
		{"token as prefix", req("Authorization", "Bearer tok-1234"), false},
		{"token as suffix", req("Authorization", "Bearer xtok-123"), false},
		{"leading space in token", req("Authorization", "Bearer  tok-123"), false},
		{"trailing space in token", req("Authorization", "Bearer tok-123 "), false},
	}
	for _, tc := range cases {
		if got := a.Authorized(tc.build()); got != tc.want {
			t.Errorf("%s: Authorized = %v, want %v", tc.name, got, tc.want)
		}
	}
}

// TestNilAuthenticatorDenies guards the "forgot to wire auth" case.
func TestNilAuthenticatorDenies(t *testing.T) {
	var a *Authenticator
	if a.Authorized(req("Authorization", "Bearer anything")()) {
		t.Error("nil authenticator authorized a request")
	}
	empty := &Authenticator{}
	if empty.Authorized(req("Authorization", "Bearer anything")()) {
		t.Error("zero-value authenticator authorized a request")
	}
}

func req(header, value string) func() *http.Request {
	return func() *http.Request {
		r := httptest.NewRequest("GET", "/", nil)
		r.Header.Set(header, value)
		return r
	}
}
