package monitor

import "golang.org/x/text/collate"

// x/text has zh-Hant stroke weights but does not implement CLDR script reordering
// (collate.Reorder panics). Node's zh-Hant puts Han after numbers, before Latin.
// Compare reordered primary weights, then use x/text for secondary/case ties.
// This adapter depends on the pinned x/text key encoding in collate.go;
// the Node/Go differential test covers mixed scripts, accents and prefixes.
// Unicode characters added after x/text's collation tables may still differ
// from a newer ICU. See docs/migration.md.
type collationOrder struct {
	collator *collate.Collator
	buffer   collate.Buffer
	keys     map[string][]byte
}

func (c *collationOrder) key(s string) []byte {
	if key, ok := c.keys[s]; ok {
		return key
	}
	c.buffer.Reset()
	key := append([]byte(nil), c.collator.KeyFromString(&c.buffer, s)...)
	c.keys[s] = key
	return key
}
func (c *collationOrder) compare(a, b string) int {
	ak, bk := c.key(a), c.key(b)
	for {
		ap, an := primary(ak)
		bp, bn := primary(bk)
		if ap == 0 || bp == 0 {
			if ap < bp {
				return -1
			}
			if ap > bp {
				return 1
			}
			return c.collator.CompareString(a, b)
		}
		ap = reorderPrimary(ap)
		bp = reorderPrimary(bp)
		if ap < bp {
			return -1
		}
		if ap > bp {
			return 1
		}
		ak = ak[an:]
		bk = bk[bn:]
	}
}
func primary(key []byte) (int, int) {
	if len(key) < 2 || key[0] == 0 && key[1] == 0 {
		return 0, 0
	}
	if key[0]&0x80 != 0 {
		return int(key[0]&0x7f)<<16 | int(key[1])<<8 | int(key[2]), 3
	}
	return int(key[0])<<8 | int(key[1]), 2
}
func reorderPrimary(p int) int {
	if p >= 0x160000 && p < 0x170000 {
		return p - 0x150000
	}
	if p >= 0x15ef {
		return p + 0x200000
	}
	return p
}
