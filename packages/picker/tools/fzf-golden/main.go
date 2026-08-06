// Command fzf-golden freezes fzf's own FuzzyMatchV2 output into the golden
// corpus that ../../test/fuzzy.test.ts replays against the TypeScript port in
// ../../src/fuzzy.ts.
//
// This is the only thing in the repository that is Go, and nothing runs it
// automatically: no mise task, no hk step, no test. It exists so the corpus is
// regenerable rather than magic, and it is run by hand — with a network, a Go
// toolchain, and roughly ten seconds — on the resync triggers documented in
// ../../src/fuzzy.ts.
//
// Regenerate with:
//
//	cd packages/picker/tools/fzf-golden
//	go run . > ../../test/fixtures/fzf-golden.jsonl
//
// Then run `mise run test`. A diff in the corpus with a green test means fzf
// changed something the port already agrees with; a red test means the port
// needs the same change. Bump fzfVersion below and the `go get` pin together —
// the test asserts the corpus header against the version fuzzy.ts documents,
// so they cannot drift apart silently.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"sort"
	"strings"

	"github.com/junegunn/fzf/src/algo"
	"github.com/junegunn/fzf/src/util"
)

// fzfVersion is the upstream tag this corpus was cut from. It must match the
// version in go.mod and the one fuzzy.ts documents.
const fzfVersion = "v0.74.2"

// randomSeed fixes the generated half of the corpus. Regenerating with an
// unchanged seed and an unchanged fzf produces a byte-identical file, so a
// corpus diff always means something real changed.
const randomSeed = 20260806

// Slab sizes copied from fzf's src/core.go, where they are unexported. One slab
// is reused across every case on purpose: that is how an fzf worker runs it, and
// it leaves stale data in the arrays between calls. FuzzyMatchV2's backtrace
// carries two guards against reading that stale data, so a reused slab is the
// configuration that actually exercises them.
const (
	slab16Size = 100 * 1024
	slab32Size = 2048
)

// record is one corpus line: the inputs, the smart-case decision derived from
// them, and what fzf returned.
type record struct {
	Text string `json:"text"`
	// Query is the raw query, before smart-case lowering. The TypeScript side
	// has to re-derive CaseSensitive from it, so the derivation is checked data
	// rather than described behaviour.
	Query         string `json:"query"`
	CaseSensitive bool   `json:"caseSensitive"`
	Match         bool   `json:"match"`
	Score         int    `json:"score"`
	// Positions are code-point indices into Text, ascending. fzf's backtrace
	// emits them descending; they are reversed here so the corpus reads the way
	// a highlighter wants them.
	Positions []int `json:"positions"`
}

// group is a set of texts crossed with the queries chosen to probe them.
type group struct {
	texts   []string
	queries []string
	// caseVariants also emits each query shouted and with only its first
	// character raised, which flips the smart-case decision. Set only where the
	// text has case worth probing — switching it on everywhere triples the
	// corpus to buy near-duplicate rows.
	caseVariants bool
}

func main() {
	if !algo.Init("default") {
		fmt.Fprintln(os.Stderr, "algo.Init(\"default\") failed")
		os.Exit(1)
	}

	out := bufio.NewWriter(os.Stdout)
	defer func() { _ = out.Flush() }()

	// Header line: the pinned upstream, as data the test can assert.
	if err := writeLine(out, map[string]string{"fzf": fzfVersion}); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	slab := util.MakeSlab(slab16Size, slab32Size)
	seen := map[string]bool{}

	emit := func(text, query string) {
		key := text + "\x00" + query
		if seen[key] {
			return
		}
		seen[key] = true
		if err := writeLine(out, match(slab, text, query)); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	}

	for _, g := range groups() {
		for _, text := range g.texts {
			for _, query := range g.queries {
				emit(text, query)
				if g.caseVariants {
					emit(text, strings.ToUpper(query))
					emit(text, titleFirst(query))
				}
			}
		}
	}

	for _, pair := range randomPairs() {
		emit(pair[0], pair[1])
	}
}

// match runs one case through fzf exactly as fzf itself would, deriving
// case sensitivity the way src/pattern.go's BuildPattern does.
func match(slab *util.Slab, text, query string) record {
	caseSensitive := strings.ToLower(query) != query
	patternSource := query
	if !caseSensitive {
		patternSource = strings.ToLower(query)
	}

	chars := util.ToChars([]byte(text))
	res, pos := algo.FuzzyMatchV2(caseSensitive, false, true, &chars, []rune(patternSource), true, slab)

	rec := record{
		Text:          text,
		Query:         query,
		CaseSensitive: caseSensitive,
		Positions:     []int{},
	}
	if res.Start < 0 {
		return rec
	}
	rec.Match = true
	rec.Score = res.Score
	if pos != nil {
		rec.Positions = append(rec.Positions, *pos...)
		sort.Ints(rec.Positions)
	}
	return rec
}

func writeLine(out *bufio.Writer, v any) error {
	encoded, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if _, err := out.Write(encoded); err != nil {
		return err
	}
	return out.WriteByte('\n')
}

// titleFirst raises the first character of s, which is the cheapest way to flip
// a query from smart-case-insensitive to smart-case-sensitive.
func titleFirst(s string) string {
	runes := []rune(s)
	if len(runes) == 0 {
		return s
	}
	return strings.ToUpper(string(runes[0])) + string(runes[1:])
}

func groups() []group {
	return []group{
		// The domain the issue names: every row the picker will show carries an
		// issue-key prefix, which is exactly what makes a greedy matcher put the
		// highlight in the wrong place.
		{
			texts: []string{
				"EXC-1010/fuzzy-matcher-fzf-v2",
				"EXC-985/scaffold-the-bun-workspace-and-toolchain",
				"EXC-1006/background-refresh",
				"EXC-1007/stack-graph",
				"EXC-1008/add-width-keyed-pr-preview-renderer",
				"EXC-1005/unified-pr-cache",
				"EXC-1004/add-typed-gh-adapter",
				"EXC-1011/picker-list-filter-highlight-identity",
				"trunk",
			},
			queries: []string{
				"e", "x", "c", "exc", "ex", "xc", "1010", "10", "100",
				"f", "fz", "fzf", "fuzzy", "match", "matcher", "v2",
				"stack", "graph", "sg", "bg", "bgr", "refresh", "rf",
				"cache", "ch", "adapter", "gh", "pr", "prc", "picker", "pkr",
				"identity", "id", "trunk", "tk", "wksp", "bun", "toolchain",
			},
		},
		// Smart case, probed head-on: every query here is emitted lowercase,
		// shouted, and title-cased, against texts that carry an uppercase
		// prefix and a lowercase tail. A lowercase query must reach both; one
		// uppercase character must confine it to the prefix.
		{
			texts: []string{
				"EXC-1010/fuzzy-matcher-fzf-v2",
				"EXC-1011 Picker: list, filter, highlight, identity",
				"camelCaseWord",
				"lower-only-text",
			},
			queries: []string{
				"exc", "e", "ex", "c", "cw", "ccw", "list", "l", "lo", "f",
				"fzf", "picker", "id", "text", "t",
			},
			caseVariants: true,
		},
		// PR titles, the other row shape.
		{
			texts: []string{
				"EXC-1006 Background refresh (#28)",
				"EXC-1007 Stack graph (#27)",
				"EXC-1008 Add width-keyed PR preview renderer (#26)",
				"EXC-1005 Unified PR cache (#24)",
				"EXC-1004 Add typed gh adapter (#23)",
				"feat(picker): port fzf's v2 fuzzy matcher",
				"fix(cache): drop the stale entry before refresh",
				"chore(deps): bump biome to 2.5.6",
			},
			queries: []string{
				"e", "b", "br", "bgr", "add", "pr", "prv", "preview", "render",
				"28", "26", "#2", "feat", "fix", "chore", "deps", "biome",
				"cache", "stale", "drop", "fzf", "v2", "picker", "port",
				"EXC", "Exc", "PR", "Pr", "Add", "ADD",
			},
		},
		// Paths: the delimiter class and its boundary bonus.
		{
			texts: []string{
				"packages/picker/src/fuzzy.ts",
				"packages/picker/test/fixtures/fzf-golden.jsonl",
				"packages/wrk/test/naming.test.ts",
				"scripts/tasks/lib/exec.ts",
				"a/b:c;d|e,f",
				"///leading",
				"trailing///",
				"/",
				"a,b,c,d,e",
			},
			queries: []string{
				"ppsf", "pst", "src", "test", "ts", "fuzzy", "fz", "wrk",
				"exec", "lib", "tasks", "naming", "json", "jsonl", "fixt",
				"abc", "abcdef", "abcde", "adef", "cf", "ef", "ld", "tr", "/",
			},
		},
		// fzf's own algorithm docblock examples, the cases the scoring
		// constants were chosen for.
		{
			texts:   []string{"fuzzyfinder", "fuzzy-finder", "fuzzy-blurry-finder"},
			queries: []string{"ff", "ff", "fuzzyf", "fzf", "finder", "fu", "fd"},
		},
		{
			texts:   []string{"fo-bar", "foob-r", "foobar", "foo-bar", "out-of-bound"},
			queries: []string{"br", "foob", "oob", "fb", "fr", "ob", "our", "bar", "b"},
		},
		{
			texts:   []string{"to-go", "ongoing", "going", "go"},
			queries: []string{"og", "ogo", "go", "g", "o", "oo", "ggg"},
		},
		// Character-class transitions: camelCase, letter123, screaming snake.
		{
			texts: []string{
				"camelCaseWord",
				"snake_case_word",
				"kebab-case-word",
				"SCREAMING_SNAKE_CASE",
				"XMLHttpRequest",
				"file123name",
				"abc123def456",
				"v2",
				"version2point0",
				"a1b2c3",
			},
			queries: []string{
				"ccw", "cw", "cc", "scw", "kcw", "ssc", "xhr", "xml", "req",
				"f1n", "123", "1", "2", "456", "a1", "abc", "v2", "v20",
				"Word", "word", "CASE", "case", "Case",
			},
		},
		// Whitespace, the third boundary class.
		{
			texts: []string{
				"  spaced  out  ",
				"leading space",
				"trailing space ",
				"tab\tseparated\tvalues",
				"multi\nline\ntext",
				" ",
			},
			queries: []string{"so", "sp", "out", "ls", "ts", "tsv", "mlt", "line", " ", "  "},
		},
		// Degenerate shapes: repetition, single characters, exhaustive matches.
		{
			texts: []string{
				"aaaaaaaa",
				"abababab",
				"aXbXcX",
				"a",
				"ab",
				"1234567890",
				"",
			},
			queries: []string{
				"", "a", "aa", "aaa", "aaaaaaaa", "aaaaaaaaa", "ab", "abab",
				"axbxcx", "AXBXCX", "x", "z", "1", "0", "1234567890", "13579",
			},
		},
		// Unicode: non-ASCII pushes fzf onto its rune representation, which
		// skips the ASCII prefilter the port does not implement.
		{
			texts: []string{
				"café-résumé",
				"naïve-approach",
				"Ünicode-Ärger",
				"日本語のテキスト",
				"中文-混合-english",
				"emoji-🚀-launch",
				"🎉party🎉time🎉",
				"ΣΟΦΟΣ-σοφός",
				"Ελληνικά",
			},
			queries: []string{
				"cafe", "café", "cr", "ré", "resume", "résumé", "na", "ni",
				"naive", "naïve", "un", "ün", "arger", "ärger",
				"日本", "本語", "テキスト", "中文", "混合", "english", "en",
				"🚀", "emoji", "launch", "party", "time", "🎉",
				"σοφ", "σοφός", "ΣΟΦ", "ελλ", "Ελλ",
			},
		},
		// The case-mapping traps. Go's unicode.ToLower is a simple 1:1 mapping;
		// JavaScript's String#toLowerCase is a full mapping that can expand one
		// code point into several. Every code point where the two disagree
		// belongs here, so a divergence is a red test rather than a latent bug.
		{
			texts: []string{
				"İstanbul", "ISTANBUL", "istanbul", "Istanbul",
				"straße", "STRASSE", "Straße", "ẞIG", "ßig",
				"ıI", "Iı", "ıi", "Iİ",
				"τέλος", "ΤΈΛΟΣ", "σοφος", "ΣΟΦΟΣ", "ςιγμα",
				"ǅ", "Ǆ", "ǆ",
			},
			queries: []string{
				"i", "I", "İ", "ı", "is", "IS", "İS", "ist", "stan",
				"ss", "SS", "ß", "ẞ", "stra", "STRA", "straße", "strasse",
				"σ", "Σ", "ς", "τε", "τέ", "λο", "ΛΟ",
				"ǅ", "Ǆ", "ǆ", "d", "D", "z",
			},
		},
	}
}

// randomPairs generates the breadth half of the corpus: texts assembled from a
// mixed alphabet, each probed with one query guaranteed to be a subsequence and
// one that is very likely not.
func randomPairs() [][2]string {
	rng := rand.New(rand.NewSource(randomSeed))
	alphabet := []rune("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_/.:;|, éÜ日🚀")

	pairs := make([][2]string, 0, 500)
	for range 250 {
		length := 5 + rng.Intn(44)
		text := make([]rune, length)
		for i := range text {
			text[i] = alphabet[rng.Intn(len(alphabet))]
		}

		// A subsequence of the text, in order — always a match.
		subLen := 1 + rng.Intn(5)
		sub := make([]rune, 0, subLen)
		cursor := 0
		for range subLen {
			if cursor >= len(text) {
				break
			}
			cursor += rng.Intn(len(text)-cursor+1)/2 + 1
			if cursor > len(text) {
				break
			}
			sub = append(sub, text[cursor-1])
		}

		// Free-form noise — usually a non-match, occasionally a lucky hit.
		noise := make([]rune, 1+rng.Intn(4))
		for i := range noise {
			noise[i] = alphabet[rng.Intn(len(alphabet))]
		}

		pairs = append(pairs, [2]string{string(text), string(sub)}, [2]string{string(text), string(noise)})
	}
	return pairs
}
