package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/vikricahya64-alt/jarvis/edge/internal/agent"
	"github.com/vikricahya64-alt/jarvis/edge/internal/authz"
	"github.com/vikricahya64-alt/jarvis/edge/internal/policy"
)

const testToken = "s3cr3t-device-token"

func newTestServer(t *testing.T, token string, roots []string, write bool) *Server {
	t.Helper()
	auth, err := authz.New(token)
	if err != nil {
		t.Fatal(err)
	}
	ag := agent.New(agent.Config{
		Policy:         policy.Config{Roots: roots, AllowWrite: write},
		CommandTimeout: 5 * time.Second,
	})
	return New(Config{Auth: auth, Agent: ag})
}

func authed(t *testing.T, path, body string) *http.Request {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", "Bearer "+testToken)
	return r
}

// TestUnauthenticatedExecuteIsRefused is the regression test for the single
// most serious finding in the audit: vercel-leg/termux/server.js exposed
// POST /execute -> execSync(command) with no authentication, bound to
// 0.0.0.0, and published through a public `cloudflared tunnel --url`.
func TestUnauthenticatedExecuteIsRefused(t *testing.T) {
	s := newTestServer(t, testToken, nil, false)
	h := s.Handler()

	cases := []struct{ method, path, body string }{
		{http.MethodPost, "/execute", `{"command":"id"}`},
		{http.MethodPost, "/readfile", `{"filepath":"/etc/passwd"}`},
		{http.MethodPost, "/writefile", `{"filepath":"/tmp/pwn","content":"x"}`},
		{http.MethodPost, "/listdir", `{"dirpath":"/"}`},
		{http.MethodGet, "/status", ``},
	}
	for _, tc := range cases {
		r := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
		if tc.body != "" {
			r.Header.Set("Content-Type", "application/json")
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != http.StatusUnauthorized {
			t.Errorf("%s %s without a token = %d, want 401", tc.method, tc.path, w.Code)
		}
		if strings.Contains(w.Body.String(), "root:") {
			t.Errorf("%s leaked file content without a token", tc.path)
		}
	}
}

func TestWrongTokenIsRefused(t *testing.T) {
	s := newTestServer(t, testToken, nil, false)
	for _, tok := range []string{"", "wrong", testToken + "x", " " + testToken, strings.ToUpper(testToken)} {
		r := httptest.NewRequest(http.MethodPost, "/execute", strings.NewReader(`{"command":"id"}`))
		r.Header.Set("Content-Type", "application/json")
		if tok != "" {
			r.Header.Set("Authorization", "Bearer "+tok)
		}
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		if w.Code != http.StatusUnauthorized {
			t.Errorf("token %q = %d, want 401", tok, w.Code)
		}
	}
}

// TestDeviceKeyHeaderAccepted keeps compatibility with the existing
// long-poll client (vercel-leg/api/device_gateway.py speaks X-Device-Key).
func TestDeviceKeyHeaderAccepted(t *testing.T) {
	s := newTestServer(t, testToken, nil, false)
	r := httptest.NewRequest(http.MethodPost, "/execute", strings.NewReader(`{"command":"echo ok"}`))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-Device-Key", testToken)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("X-Device-Key rejected: %d %s", w.Code, w.Body.String())
	}
}

func TestAuthFailsClosedWhenTokenBlank(t *testing.T) {
	// authz.New refuses a blank token, so a misconfigured agent cannot come up.
	if _, err := authz.New(""); err == nil {
		t.Fatal("authz.New accepted a blank token")
	}
	if _, err := authz.New("   "); err == nil {
		t.Fatal("authz.New accepted a whitespace-only token")
	}
}

func TestExecuteDeniedByPolicyReturns403(t *testing.T) {
	s := newTestServer(t, testToken, nil, false)
	r := authed(t, "/execute", `{"command":"rm -rf /"}`)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	// 403, not 200: the old agent answered 200 with success:true for a
	// refusal, so an orchestrator could not distinguish deny from run.
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (body=%s)", w.Code, w.Body.String())
	}
	var got agent.Result
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if !got.Denied || got.Rule == "" {
		t.Errorf("body does not communicate the denial: %+v", got)
	}
}

func TestExecuteAllowed(t *testing.T) {
	s := newTestServer(t, testToken, nil, false)
	r := authed(t, "/execute", `{"command":"echo authenticated"}`)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "authenticated") {
		t.Errorf("body = %s", w.Body.String())
	}
	if cc := w.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", cc)
	}
}

func TestWriteRespectsRootsOverHTTP(t *testing.T) {
	root := t.TempDir()
	s := newTestServer(t, testToken, []string{root}, true)

	inside := filepath.Join(root, "ok.txt")
	r := authed(t, "/writefile", `{"filepath":`+jsonStr(inside)+`,"content":"hello"}`)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("write inside root = %d %s", w.Code, w.Body.String())
	}
	if b, err := os.ReadFile(inside); err != nil || string(b) != "hello" {
		t.Fatalf("content = %q err = %v", b, err)
	}

	// Traversal out of the root must be refused even with a valid token.
	r2 := authed(t, "/writefile", `{"filepath":"/tmp/jarvis-edge-escape","content":"x"}`)
	w2 := httptest.NewRecorder()
	s.Handler().ServeHTTP(w2, r2)
	if w2.Code != http.StatusForbidden {
		t.Fatalf("write outside root = %d, want 403", w2.Code)
	}
	if _, err := os.Stat("/tmp/jarvis-edge-escape"); err == nil {
		t.Fatal("write outside the root SUCCEEDED")
	}
}

// TestHealthzIsOpenButLeaksNothing: a tunnel or uptime check needs it, so it
// must not require a token, and it must not disclose anything.
func TestHealthzIsOpenButLeaksNothing(t *testing.T) {
	s := newTestServer(t, testToken, []string{"/etc"}, true)
	for _, p := range []string{"/healthz", "/ping"} {
		r := httptest.NewRequest(http.MethodGet, p, nil)
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		if w.Code != http.StatusOK {
			t.Fatalf("%s = %d, want 200", p, w.Code)
		}
		body := w.Body.String()
		for _, leak := range []string{testToken, "/etc", "allow_write", "roots"} {
			if strings.Contains(body, leak) {
				t.Errorf("%s leaked %q: %s", p, leak, body)
			}
		}
	}
}

func TestMalformedAndOversizedBodiesRejected(t *testing.T) {
	s := newTestServer(t, testToken, nil, false)
	for _, body := range []string{`not json`, `{"command":`, `{}`, `{"unknown_field":1,"command":"id"}`} {
		r := authed(t, "/execute", body)
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		if w.Code != http.StatusBadRequest {
			t.Errorf("body %q = %d, want 400", body, w.Code)
		}
	}

	big := `{"command":"` + strings.Repeat("A", 2<<20) + `"}`
	r := authed(t, "/execute", big)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("oversized body = %d, want 400", w.Code)
	}
}

func TestListDirOverHTTP(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "f.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	s := newTestServer(t, testToken, []string{root}, false)
	r := authed(t, "/listdir", `{"dirpath":`+jsonStr(root)+`}`)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "f.txt") {
		t.Fatalf("listdir = %d %s", w.Code, w.Body.String())
	}
}

func jsonStr(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
