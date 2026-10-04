package agent

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/vikricahya64-alt/jarvis/edge/internal/policy"
)

func newTestAgent(t *testing.T, roots []string, write bool) *Agent {
	t.Helper()
	return New(Config{
		Policy:         policy.Config{Roots: roots, AllowWrite: write},
		CommandTimeout: 2 * time.Second,
	})
}

func TestExecDeniedIsNotRun(t *testing.T) {
	a := newTestAgent(t, nil, false)
	marker := filepath.Join(t.TempDir(), "must-not-exist")
	// `mkdir` is denied by the read_only principle, and would leave an
	// observable side effect if the deny were only cosmetic.
	res := a.Exec(context.Background(), "mkdir "+marker)
	if !res.Denied {
		t.Fatalf("mutating command was not denied: %+v", res)
	}
	if res.Rule != "read_only" {
		t.Errorf("Rule = %q, want read_only", res.Rule)
	}
	if res.Reason == "" {
		t.Error("denial must carry a reason")
	}
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("DENIED COMMAND STILL EXECUTED")
	}

	// The original RCE payload shape from the old unauthenticated endpoint.
	res2 := a.Exec(context.Background(), "rm -rf /tmp/jarvis-edge-nope")
	if !res2.Denied || res2.Rule != "no_destroy" {
		t.Errorf("rm -rf not denied by no_destroy: %+v", res2)
	}
}

func TestExecAllowedRunsAndCaptures(t *testing.T) {
	a := newTestAgent(t, nil, false)
	res := a.Exec(context.Background(), "echo hello-from-agent")
	if res.Denied {
		t.Fatalf("harmless command denied: %+v", res)
	}
	if res.ExitCode != 0 {
		t.Errorf("ExitCode = %d, want 0 (stderr=%q)", res.ExitCode, res.Stderr)
	}
	if !strings.Contains(res.Stdout, "hello-from-agent") {
		t.Errorf("stdout = %q, want it to contain the echoed text", res.Stdout)
	}
	if res.Duration == "" {
		t.Error("duration not reported")
	}
}

func TestExecReportsNonZeroExit(t *testing.T) {
	a := newTestAgent(t, nil, false)
	res := a.Exec(context.Background(), "sh -c 'exit 3'")
	if res.ExitCode != 3 {
		t.Errorf("ExitCode = %d, want 3", res.ExitCode)
	}
}

func TestExecTimeoutActuallyKillsTheTree(t *testing.T) {
	// This is the behaviour Node's execSync({timeout}) could not provide: the
	// child there was killed asynchronously and `sh -c 'sleep ... & ...'`
	// grandchildren kept running on the device.
	// AllowWrite is on so that `touch` in the probe script is not refused by
	// the read_only principle: this test is about cancellation, not policy.
	a := New(Config{
		Policy:         policy.Config{AllowWrite: true},
		CommandTimeout: 300 * time.Millisecond,
	})

	marker := filepath.Join(t.TempDir(), "still-alive")
	// The grandchild would create the marker well after the timeout if it
	// survived. `sleep` is not on any denylist, so this exercises the
	// cancellation path rather than the policy path.
	script := "sleep 3; touch " + marker
	start := time.Now()
	res := a.Exec(context.Background(), script)
	elapsed := time.Since(start)

	if res.Rule != "timeout" {
		t.Fatalf("Rule = %q, want timeout (res=%+v)", res.Rule, res)
	}
	if elapsed > 2*time.Second {
		t.Errorf("Exec took %v; the timeout did not actually cut it short", elapsed)
	}
	time.Sleep(3500 * time.Millisecond)
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("grandchild SURVIVED the timeout and kept executing on the device")
	}
}

func TestOutputIsCapped(t *testing.T) {
	a := New(Config{
		Policy:         policy.Config{MaxOutputBytes: 1024},
		CommandTimeout: 10 * time.Second,
	})
	res := a.Exec(context.Background(), "head -c 200000 /dev/zero | tr '\\0' 'a'")
	if res.Denied {
		t.Fatalf("unexpected deny: %+v", res)
	}
	if len(res.Stdout) > 1024+64 {
		t.Errorf("stdout len = %d, want it capped near 1024", len(res.Stdout))
	}
	if !strings.Contains(res.Stdout, "truncated") {
		t.Error("truncation not signalled to the caller")
	}
}

func TestReadFileRespectsRootsAndRefusesSymlink(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	good := filepath.Join(root, "ok.txt")
	if err := os.WriteFile(good, []byte("inside"), 0o600); err != nil {
		t.Fatal(err)
	}
	secret := filepath.Join(outside, "secret.txt")
	if err := os.WriteFile(secret, []byte("TOPSECRET"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link.txt")
	if err := os.Symlink(secret, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	a := newTestAgent(t, []string{root}, true)

	if got, err := a.ReadFile(good, 0); err != nil || got != "inside" {
		t.Errorf("ReadFile(inside) = %q, %v; want \"inside\", nil", got, err)
	}
	if _, err := a.ReadFile(secret, 0); err == nil {
		t.Error("read OUTSIDE the root succeeded")
	}
	if _, err := a.ReadFile(link, 0); err == nil {
		t.Error("read through a symlink succeeded (must refuse)")
	}
	if _, err := a.ReadFile(root, 0); err == nil {
		t.Error("read of a directory succeeded")
	}
}

func TestWriteFileRespectsRootsAndMode(t *testing.T) {
	root := t.TempDir()
	a := newTestAgent(t, []string{root}, true)

	target := filepath.Join(root, "nested", "deep", "out.txt")
	if err := a.WriteFile(target, "payload"); err != nil {
		t.Fatalf("WriteFile inside root failed: %v", err)
	}
	b, err := os.ReadFile(target)
	if err != nil || string(b) != "payload" {
		t.Fatalf("content = %q, %v", b, err)
	}
	fi, err := os.Stat(target)
	if err != nil {
		t.Fatal(err)
	}
	if perm := fi.Mode().Perm(); perm&0o077 != 0 {
		t.Errorf("file mode = %#o, want no group/other access", perm)
	}

	if err := a.WriteFile("/tmp/escape.txt", "x"); err == nil {
		t.Error("write OUTSIDE the root succeeded")
	}

	ro := newTestAgent(t, []string{root}, false)
	if err := ro.WriteFile(filepath.Join(root, "nope.txt"), "x"); err == nil {
		t.Error("write succeeded on a read-only agent")
	}
}

func TestListDir(t *testing.T) {
	root := t.TempDir()
	for _, n := range []string{"c.txt", "a.txt", "b.txt"} {
		if err := os.WriteFile(filepath.Join(root, n), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(root, "zdir"), 0o700); err != nil {
		t.Fatal(err)
	}
	a := newTestAgent(t, []string{root}, false)
	ents, err := a.ListDir(root)
	if err != nil {
		t.Fatalf("ListDir failed: %v", err)
	}
	var names []string
	for _, e := range ents {
		names = append(names, e.Name)
	}
	want := []string{"a.txt", "b.txt", "c.txt", "zdir"}
	if strings.Join(names, ",") != strings.Join(want, ",") {
		t.Errorf("ListDir = %v, want %v (sorted)", names, want)
	}
	if _, err := a.ListDir("/etc"); err == nil {
		t.Error("ListDir outside the root succeeded")
	}
}

func TestNoRootsMeansNoFilesystemAccess(t *testing.T) {
	a := newTestAgent(t, nil, true)
	if _, err := a.ReadFile("/etc/hostname", 0); err == nil {
		t.Error("ReadFile succeeded with zero roots configured")
	}
	if err := a.WriteFile("/tmp/x", "x"); err == nil {
		t.Error("WriteFile succeeded with zero roots configured")
	}
	if _, err := a.ListDir("/tmp"); err == nil {
		t.Error("ListDir succeeded with zero roots configured")
	}
}
