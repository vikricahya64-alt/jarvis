// Package httpapi exposes the agent over HTTP.
//
// The bind address defaults to 127.0.0.1. The JavaScript agent this replaces
// called app.listen(PORT, "0.0.0.0") and its start script then published it
// with `cloudflared tunnel --url`, a quick tunnel that Cloudflare documents
// as having no access control whatsoever. Binding loopback by default means
// the safe configuration is the default one; opening the socket becomes a
// deliberate act.
package httpapi

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/vikricahya64-alt/jarvis/edge/internal/agent"
	"github.com/vikricahya64-alt/jarvis/edge/internal/authz"
	"github.com/vikricahya64-alt/jarvis/edge/internal/policy"
)

// Server wires authz, policy and agent into an http.Handler.
type Server struct {
	auth  *authz.Authenticator
	ag    *agent.Agent
	log   *slog.Logger
	ready func() bool
}

// Config configures a Server.
type Config struct {
	Auth   *authz.Authenticator
	Agent  *agent.Agent
	Logger *slog.Logger
	// Ready reports whether the agent has finished starting. /healthz is
	// unauthenticated (a tunnel or uptime check needs it) so it must never
	// leak anything beyond liveness.
	Ready func() bool
}

// New builds a Server.
func New(cfg Config) *Server {
	log := cfg.Logger
	if log == nil {
		log = slog.Default()
	}
	ready := cfg.Ready
	if ready == nil {
		ready = func() bool { return true }
	}
	return &Server{auth: cfg.Auth, ag: cfg.Agent, log: log, ready: ready}
}

// Handler returns the routed handler.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	// Unauthenticated liveness only. No version, no paths, no config.
	mux.HandleFunc("GET /healthz", s.handleHealthz)
	mux.HandleFunc("GET /ping", s.handleHealthz)

	// Everything below requires the bearer token.
	mux.HandleFunc("POST /execute", s.guard(s.handleExecute))
	mux.HandleFunc("POST /readfile", s.guard(s.handleReadFile))
	mux.HandleFunc("POST /writefile", s.guard(s.handleWriteFile))
	mux.HandleFunc("POST /listdir", s.guard(s.handleListDir))
	// /status is authenticated because it reports the configured roots, which
	// is information an unauthenticated caller should not get.
	mux.HandleFunc("GET /status", s.guard(s.handleStatus))

	return s.withLogging(mux)
}

// guard enforces authentication before any handler runs.
func (s *Server) guard(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.auth.Authorized(r) {
			// Deliberately does not distinguish "no token" from "wrong token".
			s.log.Warn("auth rejected", "remote", clientIP(r), "path", r.URL.Path)
			writeJSON(w, http.StatusUnauthorized, map[string]any{
				"success": false,
				"error":   "unauthorized",
			})
			return
		}
		next(w, r)
	}
}

func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	ok := s.ready()
	status := http.StatusOK
	if !ok {
		status = http.StatusServiceUnavailable
	}
	writeJSON(w, status, map[string]any{"ok": ok})
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"success":  true,
		"hostname": hostname(),
		"uptime":   time.Since(startedAt).Round(time.Second).String(),
	})
}

type execRequest struct {
	Command string `json:"command"`
	// TimeoutSeconds is clamped to the agent's configured ceiling; a caller
	// cannot ask for an unbounded run.
	TimeoutSeconds int `json:"timeout"`
}

func (s *Server) handleExecute(w http.ResponseWriter, r *http.Request) {
	var req execRequest
	if !decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Command) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"success": false, "error": "missing 'command' field",
		})
		return
	}
	res := s.ag.Exec(r.Context(), req.Command)
	if res.Denied {
		// 403: the request was understood and refused on policy grounds.
		// The previous agent answered 200 with success:true here, so an
		// orchestrator could not tell a refusal from a run.
		s.log.Warn("execute denied", "rule", res.Rule, "reason", res.Reason,
			"remote", clientIP(r))
		writeJSON(w, http.StatusForbidden, res)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

type pathRequest struct {
	Path string `json:"filepath"`
	Dir  string `json:"dirpath"`
}

func (s *Server) handleReadFile(w http.ResponseWriter, r *http.Request) {
	var req pathRequest
	if !decode(w, r, &req) {
		return
	}
	out, err := s.ag.ReadFile(req.Path, 256<<10)
	if err != nil {
		writeJSON(w, statusForError(err), map[string]any{
			"success": false, "error": err.Error(),
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "content": out})
}

func (s *Server) handleWriteFile(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path    string `json:"filepath"`
		Content string `json:"content"`
	}
	if !decode(w, r, &req) {
		return
	}
	if err := s.ag.WriteFile(req.Path, req.Content); err != nil {
		writeJSON(w, statusForError(err), map[string]any{
			"success": false, "error": err.Error(),
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

func (s *Server) handleListDir(w http.ResponseWriter, r *http.Request) {
	var req pathRequest
	if !decode(w, r, &req) {
		return
	}
	p := req.Dir
	if p == "" {
		p = req.Path
	}
	ents, err := s.ag.ListDir(p)
	if err != nil {
		writeJSON(w, statusForError(err), map[string]any{
			"success": false, "error": err.Error(),
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "entries": ents})
}

func (s *Server) withLogging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		s.log.Info("request",
			"method", r.Method, "path", r.URL.Path,
			"status", rec.status, "dur", time.Since(start).Round(time.Millisecond),
			"remote", clientIP(r))
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

// decode reads a bounded JSON body. The old agent used express.json() with
// its default 100kb limit but the caller-controlled length still fed straight
// into execSync; here the body is bounded and the command is policy-checked.
func decode(w http.ResponseWriter, r *http.Request, dst any) bool {
	const maxBody = 1 << 20 // 1 MiB
	r.Body = http.MaxBytesReader(w, r.Body, maxBody)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"success": false, "error": "invalid JSON body: " + err.Error(),
		})
		return false
	}
	return true
}

func statusForError(err error) int {
	if errors.Is(err, policy.ErrDenied) {
		return http.StatusForbidden
	}
	return http.StatusBadRequest
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	// Responses describe device state; never let a cache keep them.
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func clientIP(r *http.Request) string {
	if v := r.Header.Get("CF-Connecting-IP"); v != "" {
		return v
	}
	host := r.RemoteAddr
	if i := strings.LastIndex(host, ":"); i > 0 {
		host = host[:i]
	}
	return strings.Trim(host, "[]")
}
