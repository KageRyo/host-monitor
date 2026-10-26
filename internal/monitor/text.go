package monitor

import (
	"strings"
	"unicode"
)

// ECMAScript trim includes BOM and excludes NEXT LINE; keep stored group/name
// identity and .env parsing consistent with the original JS and dashboard.
func trimJS(s string) string {
	return strings.TrimFunc(s, func(r rune) bool { return r == '\ufeff' || r != '\u0085' && unicode.IsSpace(r) })
}
