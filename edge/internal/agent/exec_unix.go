//go:build unix

package agent

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
)

// setPgid puts the child in its own process group.
//
// Without this, the timeout is only half-real: exec.CommandContext kills the
// direct child, but the command runs as `/bin/sh -c "..."`, which spawns
// grandchildren. Those survive the kill and keep running on the device —
// which is exactly what happened with the Node agent's execSync timeout.
func setPgid() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true}
}

// killGroup signals the entire process group, so a command that already
// forked children does not leave orphans behind. It is wired into
// exec.Cmd.Cancel so it runs the moment the context is cancelled, rather than
// after Run() has already been unblocked by WaitDelay.
func killGroup(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	// A negative pid means "the process group whose id is -pid".
	err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	if err != nil {
		// Group already gone, or Setpgid did not apply. Fall back to the direct
		// child so we still make a best effort.
		if kerr := cmd.Process.Kill(); kerr != nil && !errors.Is(kerr, os.ErrProcessDone) {
			return err
		}
	}
	return nil
}
