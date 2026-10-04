// Package policy decides whether an action is allowed.
//
// The previous agent (vercel-leg/utils/termux_executor.py) had a blocklist of
// dangerous substrings — "rm -rf /", "curl", "wget", "shutdown" — but it lived
// in the CLOUD client. The device server enforced nothing. Anyone POSTing
// straight to the tunnel URL never touched the blocklist, and even inside the
// client it was trivially bypassed:
//
//	"$(echo cm0gLXJmIC8= | base64 -d)"
//	python -c "import urllib.request; urllib.request.urlretrieve(...)"
//	r''m -rf /sdcard
//
// This package moves enforcement to the SERVER, which is the only place it
// can actually hold, and is built on the same constitutional principles the
// TypeScript edge already enforces (cf/src/lib/constitutional_guard.ts):
// no_destroy, no_exfiltrate, no_money, no_autonomy_destructive.
//
// It is deliberately an allowlist-by-default design for filesystem access
// (see Roots) and a denylist-plus-parse for commands, because a correct
// command parser is not achievable and pretending otherwise is how the old
// blocklist failed. Every deny is logged with the reason.
package policy

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// ErrDenied is returned when policy refuses an action.
var ErrDenied = errors.New("policy: denied")

// Decision is the outcome of a policy check.
type Decision struct {
	Allowed bool
	Reason  string
	Rule    string
}

// Config configures the policy engine.
type Config struct {
	// Roots, when non-empty, is an allowlist for all filesystem access.
	// An empty path outside every root is denied. This is the single most
	// important control: it is what stops arbitrary file read/write on the
	// device, which the previous anyclaw-server.js allowed outright.
	Roots []string

	// AllowWrite enables the mutating filesystem verbs. Off by default:
	// a read-only agent is still useful and much safer to expose.
	AllowWrite bool

	// AllowNetwork permits commands that can reach the network. Off by
	// default. This is the server-side counterpart of the client-side
	// "curl"/"wget" blocklist, except it now actually holds.
	AllowNetwork bool

	// MaxOutputBytes caps captured stdout/stderr per invocation.
	MaxOutputBytes int
}

func (c Config) withDefaults() Config {
	if c.MaxOutputBytes <= 0 {
		c.MaxOutputBytes = 512 << 10 // 512 KiB, same as the old maxBuffer
	}
	return c
}

// Engine evaluates actions against a Config.
type Engine struct {
	cfg Config
}

// New builds an Engine.
func New(cfg Config) *Engine {
	return &Engine{cfg: cfg.withDefaults()}
}

// MaxOutput is the per-invocation output cap.
func (e *Engine) MaxOutput() int { return e.cfg.MaxOutputBytes }

func (e *Engine) allow() Decision { return Decision{Allowed: true} }
func (e *Engine) deny(rule, reason string) Decision {
	return Decision{Allowed: false, Rule: rule, Reason: reason}
}

// principles, mirroring constitutional_guard.ts. Matching is done on a
// word-boundary basis so "skill" does not trip "kill" and "python" does not
// trip "pin" — the same discipline the TypeScript guard uses.
var principles = []struct {
	rule  string
	terms []string
}{
	{"no_destroy", []string{"rm", "rmdir", "shred", "mkfs", "dd", "unlink", "format", "wipe"}},
	{"no_autonomy_destructive", []string{"kill", "killall", "pkill", "reboot", "shutdown", "poweroff", "halt", "reset"}},
	{"no_exfiltrate", []string{"curl", "wget", "nc", "ncat", "netcat", "ssh", "scp", "sftp", "rsync", "ftp", "telnet"}},
	{"no_money", []string{"pay", "payment", "transfer", "otp", "password", "passwd"}},
}

// obfuscationMarkers catch the shapes that were used to slip past the old
// substring blocklist. This is defence in depth on top of principles, not a
// replacement for it: command-substitution indirection is refused outright
// because no legitimate agent task needs it.
//
// HONEST LIMITATION: this list is necessarily incomplete. Any shell
// invocation admits an unbounded number of equivalent spellings, so no
// denylist of this shape can ever be sound on its own — which is exactly the
// lesson of the blocklist it replaces. The real controls are (a) the token,
// (b) loopback-by-default so the endpoint is not on a network, and (c) not
// pointing a `cloudflared tunnel --url` quick tunnel at it. Treat every entry
// here as raising the cost of a casual bypass, not as a sandbox.
var obfuscationMarkers = []string{
	"base64 -d", "base64 --decode", "base64 -w", "b64decode",
	"eval ", "$(echo", "$(printf", "$(cat", "`echo",
	"| sh", "|sh", "| bash", "|bash",
	"python -c", "python3 -c", "perl -e", "ruby -e", "node -e",
	"xxd -r", "printf \\x",
}

// CheckCommand evaluates a shell command line.
//
// It is honest about its own limits: this is a lexical screen, not a shell
// parser. It stops the concrete bypass shapes above and the obvious
// destructive verbs, and it is enforced server-side where the old one was
// not. It is not a substitute for not exposing an arbitrary-execution
// endpoint to an untrusted network — the operator still has to get the
// tunnel and the token right.
func (e *Engine) CheckCommand(command string) Decision {
	cmd := strings.TrimSpace(command)
	if cmd == "" {
		return e.deny("empty", "empty command")
	}

	low := strings.ToLower(cmd)

	for _, m := range obfuscationMarkers {
		if strings.Contains(low, m) {
			return e.deny("obfuscation",
				fmt.Sprintf("command-indirection marker %q is never needed by a legitimate agent task", m))
		}
	}

	for _, p := range principles {
		for _, term := range p.terms {
			if containsWord(low, term) {
				// no_exfiltrate terms are only refused because they move data
				// off the device; AllowNetwork re-permits them deliberately.
				if p.rule == "no_exfiltrate" && e.cfg.AllowNetwork {
					continue
				}
				if !e.cfg.AllowNetwork && p.rule == "no_exfiltrate" {
					return e.deny(p.rule,
						fmt.Sprintf("network/egress tool %q refused (set AllowNetwork to permit)", term))
				}
				return e.deny(p.rule,
					fmt.Sprintf("destructive or exfiltrating term %q is refused by the %s principle", term, p.rule))
			}
		}
	}

	if !e.cfg.AllowWrite {
		for _, w := range []string{"mv", "cp", "chmod", "chown", "install", "tee", "truncate", "touch", "mkdir", "ln", "sed"} {
			if containsWord(low, w) {
				return e.deny("read_only",
					fmt.Sprintf("mutating command %q refused: agent is read-only (set AllowWrite to permit)", w))
			}
		}
		// Output redirection also mutates the filesystem. `>` and `>>` are
		// checked with the fd-duplication forms excluded, since `2>&1` and
		// `->` are not writes.
		if hasFileRedirect(cmd) {
			return e.deny("read_only",
				"output redirection refused: agent is read-only (set AllowWrite to permit)")
		}
	}

	return e.allow()
}

// CheckPath validates a filesystem path against the configured roots.
//
// Roots are resolved to absolute, symlink-free paths before use, so a symlink
// planted inside an allowed root cannot be used to escape it. When no roots
// are configured every path is denied: an agent with no configured boundary
// has no boundary, and silently allowing everything is how anyclaw-server.js
// became an arbitrary-file-write primitive.
func (e *Engine) CheckPath(p string) (string, Decision) {
	if strings.TrimSpace(p) == "" {
		return "", e.deny("empty_path", "empty path")
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", e.deny("bad_path", err.Error())
	}
	// Resolve symlinks on the deepest existing ancestor: the target file may
	// legitimately not exist yet (write), but its directory must be real.
	real := resolveExisting(abs)

	if len(e.cfg.Roots) == 0 {
		return "", e.deny("no_roots",
			"no filesystem roots configured: refusing all path access (fail-closed)")
	}
	for _, root := range e.cfg.Roots {
		rabs, err := filepath.Abs(root)
		if err != nil {
			continue
		}
		rreal := resolveExisting(rabs)
		if withinRoot(real, rreal) {
			return abs, e.allow()
		}
	}
	return "", e.deny("outside_roots",
		fmt.Sprintf("path resolves outside every configured root (checked %s)", real))
}

// CheckWrite applies CheckPath plus the read-only switch.
func (e *Engine) CheckWrite(p string) (string, Decision) {
	if !e.cfg.AllowWrite {
		return "", e.deny("read_only", "agent is read-only: writes are disabled (set AllowWrite to permit)")
	}
	return e.CheckPath(p)
}

// withinRoot reports whether target is root or sits beneath it.
func withinRoot(target, root string) bool {
	if target == root {
		return true
	}
	rel, err := filepath.Rel(root, target)
	if err != nil {
		return false
	}
	if rel == "." {
		return true
	}
	// A leading ".." means the target escaped upward.
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// resolveExisting walks up until a path exists, then evaluates symlinks on
// that ancestor and re-appends the remaining components.
func resolveExisting(p string) string {
	remainder := ""
	cur := p
	for {
		if _, err := os.Lstat(cur); err == nil {
			if resolved, err := filepath.EvalSymlinks(cur); err == nil {
				if remainder == "" {
					return resolved
				}
				return filepath.Join(resolved, remainder)
			}
			return cur
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			return p
		}
		remainder = filepath.Join(filepath.Base(cur), remainder)
		cur = parent
	}
}

// containsWord reports whether needle appears in haystack as a whole token.
// Separators are anything that is not a letter or digit, which also means
// "rm" does not match inside "confirm" and "kill" does not match "skill".
func containsWord(haystack, needle string) bool {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] != needle {
			continue
		}
		if i > 0 && isWordByte(haystack[i-1]) {
			continue
		}
		if i+len(needle) < len(haystack) && isWordByte(haystack[i+len(needle)]) {
			continue
		}
		return true
	}
	return false
}

func isWordByte(b byte) bool {
	return (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') || (b >= '0' && b <= '9')
}

// hasFileRedirect reports whether cmd contains an output redirection to a
// file. It excludes the forms that do not write to the filesystem:
//
//	2>&1, &>file-less fd dup   -> ">&"
//	->  and  =>                 -> arrow, not redirection
//
// `>&` is excluded because `>&` is almost always fd duplication, while a bare
// `>` followed by a path is a real write.
func hasFileRedirect(cmd string) bool {
	for i := 0; i < len(cmd); i++ {
		if cmd[i] != '>' {
			continue
		}
		if i > 0 && cmd[i-1] == '-' {
			continue // "->"
		}
		if i+1 < len(cmd) && cmd[i+1] == '>' {
			continue // the ">>" itself; the next iteration handles the target
		}
		if i+1 < len(cmd) && cmd[i+1] == '&' {
			continue // "2>&1" / ">&2"
		}
		return true
	}
	return false
}
