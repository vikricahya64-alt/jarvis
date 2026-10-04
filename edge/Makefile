# edge/ — build and test the J.A.R.V.I.S. device agent.
#
# `make check` is what CI should run. `make dist` is the release matrix.

GO      ?= go
BIN     := dist
PKG     := ./cmd/jarvis-edge
VERSION := m9-v12-edge.1
LDFLAGS := -s -w -X main.version=$(VERSION)

# Release matrix. CGO_ENABLED=0 so every binary is statically linked and runs
# on a device with no libc assumptions (Termux included).
TARGETS := linux/arm64 linux/amd64 linux/arm linux/arm android/arm64 darwin/arm64 darwin/amd64

.PHONY: all build test vet fmt fmtcheck check clean dist install-android

all: build

build:
	$(GO) build -trimpath -ldflags="$(LDFLAGS)" -o $(BIN)/jarvis-edge $(PKG)

test:
	$(GO) test ./...

vet:
	$(GO) vet ./...

fmt:
	$(GO) fmt ./...

fmtcheck:
	@out="$$($(GO) run mvdan.cc/gofumpt@latest -l . 2>/dev/null || gofmt -l .)"; \
	if [ -n "$$out" ]; then echo "gofmt needed:"; echo "$$out"; exit 1; fi

check: fmtcheck vet test
	@echo "check: OK"

dist:
	@mkdir -p $(BIN)
	@for t in $(TARGETS); do \
		os=$${t%/*}; arch=$${t#*/}; \
		out="$(BIN)/jarvis-edge_$${os}_$${arch}"; \
		if CGO_ENABLED=0 GOOS=$$os GOARCH=$$arch $(GO) build -trimpath \
			-ldflags="$(LDFLAGS)" -o "$$out" $(PKG); then \
			printf '  %-16s %s\n' "$$t" "$$(du -h $$out | cut -f1)"; \
		else \
			printf '  %-16s BUILD FAILED\n' "$$t"; exit 1; \
		fi; \
	done

# Convenience target for the Termux workflow: build, then print the adb push
# command. Not run by CI.
install-android: dist
	@echo "adb push $(BIN)/jarvis-edge_android_arm64 /data/local/tmp/ && chmod 755"

clean:
	rm -rf $(BIN)