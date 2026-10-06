package main

import (
	"strings"
	"syscall/js"
)

// Same workload, but WITHOUT the regexp/RE2 dependency.
var comb = strings.NewReplacer("̀", "", "́", "", "̈", "")

func Normalize(s string) string {
	s = comb.Replace(strings.ToLower(strings.TrimSpace(s)))
	return strings.Join(strings.Fields(s), " ")
}

func Scan(s string) int {
	n := 0
	for _, w := range strings.Fields(strings.ToLower(s)) {
		switch w {
		case "goyang", "jancuk", "bangsat", "mancun", "kontol", "memek":
			n++
		}
	}
	return n
}

func main() {
	js.Global().Set("jarvisNormalize", js.FuncOf(func(_ js.Value, a []js.Value) any {
		return Normalize(a[0].String())
	}))
	js.Global().Set("jarvisScan", js.FuncOf(func(_ js.Value, a []js.Value) any { return Scan(a[0].String()) }))
	js.Global().Set("jarvisReady", true)
	<-make(chan struct{})
}
