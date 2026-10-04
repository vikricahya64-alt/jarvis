package httpapi

import (
	"os"
	"time"
)

var startedAt = time.Now()

func hostname() string {
	h, err := os.Hostname()
	if err != nil {
		return "unknown"
	}
	return h
}
