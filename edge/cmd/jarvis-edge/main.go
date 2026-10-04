// Command jarvis-edge is the J.A.R.V.I.S. device agent: a single static
// binary that replaces the Node/Express agent in vercel-leg/termux/.
//
// What it replaces, and why:
//
//	vercel-leg/termux/server.js        POST /execute  -> execSync(command)
//	vercel-leg/termux/anyclaw-server.js POST /writefile -> fs.writeFileSync(any path)
//	  * no authentication of any kind on either
//	  * app.listen(PORT, "0.0.0.0")
//	  * termux/start.sh published them via `cloudflared tunnel --url`, a
//	    public quick tunnel with no access control
//	  * the only safety net was a substring blocklist in the CLOUD client
//	    (vercel-leg/utils/termux_executor.py), so a direct POST bypassed it
//
// This binary requires a token, refuses to start without one, binds loopback
// unless told otherwise, enforces policy server-side, and kills the whole
// process group on timeout.
//
// Usage:
//
//	jarvis-edge --token-file /data/data/com.termux/files/home/.jarvis/token
//	jarvis-edge --token "$JARVIS_EDGE_TOKEN" --listen 127.0.0.1:3900
//
// Environment (all optional except the token):
//
//	JARVIS_EDGE_TOKEN        bearer token
//	JARVIS_EDGE_TOKEN_FILE   path to a file holding the token
//	JARVIS_EDGE_LISTEN       default 127.0.0.1:3900
//	JARVIS_EDGE_ROOTS        comma-separated filesystem roots (required for
//	                         any path access; empty = deny all)
//	JARVIS_EDGE_ALLOW_WRITE  set to 1 to permit writes
//	JARVIS_EDGE_ALLOW_NET    set to 1 to permit network tools
//	JARVIS_EDGE_TIMEOUT      seconds, default 30
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/vikricahya64-alt/jarvis/edge/internal/agent"
	"github.com/vikricahya64-alt/jarvis/edge/internal/authz"
	"github.com/vikricahya64-alt/jarvis/edge/internal/httpapi"
	"github.com/vikricahya64-alt/jarvis/edge/internal/policy"
)

const version = "m9-v12-edge.1"

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "jarvis-edge:", err)
		os.Exit(1)
	}
}

func run() error {
	var (
		flagToken     = flag.String("token", "", "bearer token (prefer --token-file or the env var)")
		flagTokenFile = flag.String("token-file", "", "file containing the bearer token")
		flagListen    = flag.String("listen", envOr("JARVIS_EDGE_LISTEN", "127.0.0.1:3900"), "listen address")
		flagRoots     = flag.String("roots", os.Getenv("JARVIS_EDGE_ROOTS"), "comma-separated allowed filesystem roots")
		flagWrite     = flag.Bool("allow-write", envBool("JARVIS_EDGE_ALLOW_WRITE"), "permit filesystem writes")
		flagNet       = flag.Bool("allow-net", envBool("JARVIS_EDGE_ALLOW_NET"), "permit network/egress tools")
		flagTimeout   = flag.Int("timeout", envInt("JARVIS_EDGE_TIMEOUT", 30), "per-command timeout seconds")
		flagShowVer   = flag.Bool("version", false, "print version and exit")
	)
	flag.Parse()

	if *flagShowVer {
		fmt.Println(version)
		return nil
	}

	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))

	token, err := resolveToken(*flagToken, *flagTokenFile)
	if err != nil {
		// Fail closed and loudly. There is no "run without auth" mode: that
		// is precisely how the previous agent ended up on the public internet.
		return err
	}

	auth, err := authz.New(token)
	if err != nil {
		return err
	}

	roots := splitList(*flagRoots)
	for _, r := range roots {
		abs, err := filepath.Abs(r)
		if err != nil {
			return fmt.Errorf("root %q: %w", r, err)
		}
		if _, err := os.Stat(abs); err != nil {
			return fmt.Errorf("root %q: %w", abs, err)
		}
	}
	if len(roots) == 0 {
		log.Warn("no --roots configured: ALL filesystem access will be denied (fail-closed)")
	}

	ag := agent.New(agent.Config{
		Policy: policy.Config{
			Roots:          roots,
			AllowWrite:     *flagWrite,
			AllowNetwork:   *flagNet,
			MaxOutputBytes: 512 << 10,
		},
		CommandTimeout: time.Duration(*flagTimeout) * time.Second,
	})

	var ready bool
	srv := httpapi.New(httpapi.Config{
		Auth:   auth,
		Agent:  ag,
		Logger: log,
		Ready:  func() bool { return ready },
	})

	httpSrv := &http.Server{
		Addr:              *flagListen,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		// Longer than the longest possible command plus its own timeout, so a
		// slow-but-legitimate run is not cut off mid-flight.
		WriteTimeout: time.Duration(*flagTimeout+15) * time.Second,
		IdleTimeout:  60 * time.Second,
		// Bound the header size: the old server used Node defaults.
		MaxHeaderBytes: 16 << 10,
	}

	ln, err := net.Listen("tcp", *flagListen)
	if err != nil {
		return fmt.Errorf("listen %s: %w", *flagListen, err)
	}
	ready = true
	log.Info("jarvis-edge starting",
		"version", version,
		"addr", ln.Addr().String(),
		"roots", len(roots),
		"allow_write", *flagWrite,
		"allow_net", *flagNet,
		"timeout_s", *flagTimeout,
	)
	if !isLoopback(ln.Addr()) {
		log.Warn("listening on a NON-loopback address: reachable from the network. " +
			"Put it behind an authenticated tunnel (named tunnel + Access policy), " +
			"never a `cloudflared tunnel --url` quick tunnel.")
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	errCh := make(chan error, 1)
	go func() {
		if err := httpSrv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		log.Info("shutdown signal received")
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := httpSrv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("graceful shutdown: %w", err)
	}
	log.Info("stopped cleanly")
	return nil
}

// resolveToken finds the token from flag, env, or file, in that order.
func resolveToken(flagToken, flagFile string) (string, error) {
	if t := strings.TrimSpace(flagToken); t != "" {
		return t, nil
	}
	if t := strings.TrimSpace(os.Getenv("JARVIS_EDGE_TOKEN")); t != "" {
		return t, nil
	}
	if flagFile == "" {
		flagFile = os.Getenv("JARVIS_EDGE_TOKEN_FILE")
	}
	if flagFile != "" {
		b, err := os.ReadFile(flagFile)
		if err != nil {
			return "", fmt.Errorf("read token file: %w", err)
		}
		t := strings.TrimSpace(string(b))
		if t == "" {
			return "", fmt.Errorf("token file %s is empty", flagFile)
		}
		if err := checkTokenFilePerms(flagFile); err != nil {
			return "", err
		}
		return t, nil
	}
	return "", errors.New("no token configured: pass --token, --token-file, " +
		"JARVIS_EDGE_TOKEN or JARVIS_EDGE_TOKEN_FILE. Refusing to start unauthenticated.")
}

// checkTokenFilePerms refuses a token file readable by anyone else.
func checkTokenFilePerms(path string) error {
	fi, err := os.Stat(path)
	if err != nil {
		return err
	}
	if mode := fi.Mode().Perm(); mode&0o077 != 0 {
		return fmt.Errorf("token file %s has mode %#o; it must not be readable by "+
			"group or others (chmod 600)", path, mode)
	}
	return nil
}

func isLoopback(addr net.Addr) bool {
	host, _, err := net.SplitHostPort(addr.String())
	if err != nil {
		return false
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envBool(key string) bool {
	v, _ := strconv.ParseBool(os.Getenv(key))
	return v
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func splitList(s string) []string {
	var out []string
	for _, part := range strings.Split(s, ",") {
		if p := strings.TrimSpace(part); p != "" {
			out = append(out, p)
		}
	}
	return out
}
