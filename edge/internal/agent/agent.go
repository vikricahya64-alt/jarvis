// Package agent implements the device-side operations the cloud core can ask
// for: run a command, read a file, write a file, list a directory.
//
// Everything here goes through policy first. There is no code path that
// reaches os/exec or os.WriteFile without a Decision.
package agent

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"time"

	"github.com/vikricahya64-alt/jarvis/edge/internal/policy"
)

// waitDelay bounds how long Run() keeps waiting on output pipes after the
// context is cancelled. See the WaitDelay comment in Exec.
const waitDelay = 2 * time.Second

// ErrTimeout is returned when a command exceeds its deadline.
var ErrTimeout = errors.New("agent: command timed out")

// ErrTooLarge is returned when output exceeds the configured cap.
var ErrTooLarge = errors.New("agent: output exceeded cap")

// Agent performs policy-checked operations.
type Agent struct {
	pol     *policy.Engine
	shell   string
	timeout time.Duration
}

// Config configures an Agent.
type Config struct {
	Policy         policy.Config
	Shell          string
	CommandTimeout time.Duration
	MaxOutputBytes int
}

// New builds an Agent. A zero CommandTimeout falls back to 30s.
func New(cfg Config) *Agent {
	shell := cfg.Shell
	if shell == "" {
		shell = "/bin/sh"
	}
	to := cfg.CommandTimeout
	if to <= 0 {
		to = 30 * time.Second
	}
	return &Agent{
		pol:     policy.New(cfg.Policy),
		shell:   shell,
		timeout: to,
	}
}

// Result is the outcome of a command.
type Result struct {
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	ExitCode int    `json:"exit_code"`
	Duration string `json:"duration"`
	Denied   bool   `json:"denied,omitempty"`
	Reason   string `json:"reason,omitempty"`
	Rule     string `json:"rule,omitempty"`
}

// Exec runs a shell command under policy, with a real deadline.
//
// The difference from the JavaScript original is the cancellation. execSync
// with {timeout} cannot interrupt a child; Node kills it asynchronously and
// the /bin/sh process tree frequently survives, so a timed-out command kept
// running on the device. context.WithTimeout plus exec.CommandContext kills
// the process group, so an over-running command actually stops.
//
// exec.CommandContext kills the direct child, and /bin/sh -c "a && b" spawns
// grandchildren. Setting Setpgid and signalling the whole group is what makes
// the timeout real; without it the guarantee is only half-true.
func (a *Agent) Exec(ctx context.Context, command string) Result {
	if d := a.pol.CheckCommand(command); !d.Allowed {
		return Result{Denied: true, Reason: d.Reason, Rule: d.Rule, ExitCode: -1}
	}

	ctx, cancel := context.WithTimeout(ctx, a.timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, a.shell, "-c", command)
	// Own process group so the timeout can signal the entire tree.
	cmd.SysProcAttr = setPgid()

	// exec.CommandContext's default Cancel kills only the direct child, and the
	// child here is `/bin/sh -c "..."`, which forks grandchildren. Replace the
	// cancel hook so the whole process group is signalled.
	cmd.Cancel = func() error { return killGroup(cmd) }

	// Because Stdout/Stderr are not *os.File, os/exec creates pipes and copies
	// them in goroutines, and Run() waits for those copies. A surviving
	// grandchild still holds the write end, so Run() would block until the
	// grandchild exits — i.e. the timeout would not actually cut anything off.
	// WaitDelay bounds exactly that wait. Measured: without it, a 300ms timeout
	// on `sh -c "sleep 3; ..."` returned after 3.06s.
	cmd.WaitDelay = waitDelay

	var stdout, stderr cappedBuffer
	stdout.limit = a.pol.MaxOutput()
	stderr.limit = a.pol.MaxOutput()
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	start := time.Now()
	runErr := cmd.Run()
	elapsed := time.Since(start)

	res := Result{
		Stdout:   stdout.String(),
		Stderr:   stderr.String(),
		Duration: elapsed.Round(time.Millisecond).String(),
	}
	switch {
	case ctx.Err() == context.DeadlineExceeded:
		res.ExitCode = -1
		res.Reason = ErrTimeout.Error()
		res.Rule = "timeout"
	case runErr != nil:
		var ee *exec.ExitError
		if errors.As(runErr, &ee) {
			res.ExitCode = ee.ExitCode()
		} else {
			res.ExitCode = -1
			res.Reason = runErr.Error()
		}
	default:
		res.ExitCode = 0
	}
	return res
}

// ReadFile returns file contents under policy.
func (a *Agent) ReadFile(path string, maxBytes int64) (string, error) {
	abs, d := a.pol.CheckPath(path)
	if !d.Allowed {
		return "", fmt.Errorf("%w: %s (%s)", policy.ErrDenied, d.Reason, d.Rule)
	}
	if maxBytes <= 0 {
		maxBytes = 256 << 10
	}
	// O_NOFOLLOW-equivalent: refuse a symlink even if it resolves inside a
	// root, so a link cannot be used as a stable read primitive.
	fi, err := os.Lstat(abs)
	if err != nil {
		return "", err
	}
	if fi.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("%w: refusing to read through a symlink", policy.ErrDenied)
	}
	if fi.IsDir() {
		return "", fmt.Errorf("%w: %s is a directory", policy.ErrDenied, abs)
	}
	f, err := os.Open(abs)
	if err != nil {
		return "", err
	}
	defer f.Close()
	buf, err := readCapped(f, maxBytes)
	if err != nil {
		return "", err
	}
	return string(buf), nil
}

// WriteFile writes contents under policy.
func (a *Agent) WriteFile(path, content string) error {
	abs, d := a.pol.CheckWrite(path)
	if !d.Allowed {
		return fmt.Errorf("%w: %s (%s)", policy.ErrDenied, d.Reason, d.Rule)
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o700); err != nil {
		return err
	}
	// 0600: the previous implementation used the default umask and happily
	// created world-readable files holding whatever the cloud asked for.
	return os.WriteFile(abs, []byte(content), 0o600)
}

// ListDir returns a directory listing under policy.
func (a *Agent) ListDir(path string) ([]DirEntry, error) {
	abs, d := a.pol.CheckPath(path)
	if !d.Allowed {
		return nil, fmt.Errorf("%w: %s (%s)", policy.ErrDenied, d.Reason, d.Rule)
	}
	ents, err := os.ReadDir(abs)
	if err != nil {
		return nil, err
	}
	out := make([]DirEntry, 0, len(ents))
	for _, e := range ents {
		out = append(out, DirEntry{
			Name:  e.Name(),
			IsDir: e.IsDir(),
			Size:  infoSize(e),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// DirEntry is one listing row.
type DirEntry struct {
	Name  string `json:"name"`
	IsDir bool   `json:"is_dir"`
	Size  int64  `json:"size"`
}

func infoSize(e os.DirEntry) int64 {
	info, err := e.Info()
	if err != nil {
		return 0
	}
	return info.Size()
}

// cappedBuffer collects output up to a limit and records that it truncated,
// rather than allocating without bound the way a 512 KiB maxBuffer plus
// string concatenation did.
type cappedBuffer struct {
	buf       bytes.Buffer
	limit     int
	truncated bool
}

func (c *cappedBuffer) Write(p []byte) (int, error) {
	if c.buf.Len() < c.limit {
		n := c.limit - c.buf.Len()
		if n > len(p) {
			n = len(p)
		}
		c.buf.Write(p[:n])
		if n < len(p) {
			c.truncated = true
		}
	}
	return len(p), nil // never error: the child keeps running
}

func (c *cappedBuffer) String() string {
	if c.truncated {
		return c.buf.String() + "\n...[output truncated at limit]"
	}
	return c.buf.String()
}

func readCapped(f *os.File, max int64) ([]byte, error) {
	buf := make([]byte, max+1)
	n, err := f.Read(buf)
	if n == 0 {
		if errors.Is(err, io.EOF) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		return nil, nil
	}
	if int64(n) > max {
		return buf[:max], nil
	}
	return buf[:n], nil
}
