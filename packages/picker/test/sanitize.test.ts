/**
 * The trust boundary, stated as the sequences that must not survive it.
 *
 * A picker row is a branch name or a pull-request title, and on a fork both are written by
 * whoever opened the pull request. Writing one to a terminal unfiltered hands that person
 * the terminal: an escape sequence can move the cursor, erase the screen, rename the
 * window, or — through OSC 52 — put text on the user's clipboard. The allowlist is colour
 * and nothing else, and **this file is what pins it**: the module's own header explains why
 * there is no upstream version to resync against, so a regression here is caught by these
 * cases or it is not caught.
 *
 * Every case below names a sequence a real terminal acts on, or a character that reorders
 * what a reader sees, so a failure is a change in what an attacker can do — not a
 * formatting nit.
 *
 * @packageDocumentation
 */

import { describe, expect, test } from "bun:test";

import { sanitize, sanitizePreview, stripSgr } from "../src/sanitize";

/**
 * A control character by code point.
 *
 * The alternative is embedding the bytes themselves, which makes every case below a line
 * with an invisible hole in it — the same problem `fixtures/pty.ts` names, arriving here as
 * unreadable test data rather than as an unreadable pattern.
 */
const ctrl = (code: number): string => String.fromCodePoint(code);

const ESC = ctrl(0x1b);
const BEL = ctrl(0x07);
const DEL = ctrl(0x7f);

/** `ESC \`, the seven-bit String Terminator — the other way an OSC ends. */
const ST = ESC + ctrl(0x5c);

/** Eight-bit CSI and OSC: the C1 twins of `ESC [` and `ESC ]`. */
const C1_CSI = ctrl(0x9b);
const C1_OSC = ctrl(0x9d);

/** Red foreground, then default foreground — the shape the allowlist exists to pass. */
const RED = `${ESC}[31m`;
const RESET = `${ESC}[39m`;

describe("colour survives", () => {
  test("an SGR run passes through byte for byte", () => {
    expect(sanitize(`${RED}danger${RESET}`)).toBe(`${RED}danger${RESET}`);
  });

  test("so do the compound and reset forms", () => {
    // `1;38;5;196m` (bold + 256-colour) and a bare `m`, which terminals read as `0m`.
    expect(sanitize(`${ESC}[1;38;5;196mx${ESC}[m`)).toBe(`${ESC}[1;38;5;196mx${ESC}[m`);
  });

  test("text with no escapes at all is returned unchanged", () => {
    expect(sanitize("EXC-1011 Picker: list, filter, highlight")).toBe(
      "EXC-1011 Picker: list, filter, highlight",
    );
  });

  test("astral characters are not sliced apart", () => {
    expect(sanitize("🚀 ship it 日本語")).toBe("🚀 ship it 日本語");
  });
});

describe("everything else is dropped", () => {
  test("erase-screen, the sequence that eats the frame", () => {
    expect(sanitize(`before${ESC}[2Jafter`)).toBe("beforeafter");
  });

  test("cursor addressing, the sequence that draws outside the frame", () => {
    expect(sanitize(`a${ESC}[10;1Hb${ESC}[5Ac`)).toBe("abc");
  });

  test("an OSC terminated by BEL — the window-title and clipboard family", () => {
    expect(sanitize(`title${ESC}]0;pwned${BEL}here`)).toBe("titlehere");
  });

  test("an OSC terminated by ST", () => {
    expect(sanitize(`copy${ESC}]52;c;cHduZWQ=${ST}here`)).toBe("copyhere");
  });

  test("an unterminated OSC does not survive by running off the end", () => {
    expect(sanitize(`${ESC}]0;never closed`)).toBe("");
  });

  test("a two-character escape such as RIS", () => {
    expect(sanitize(`a${ESC}cb`)).toBe("ab");
  });

  test("a lone trailing ESC, which starts nothing", () => {
    expect(sanitize(`tail${ESC}`)).toBe("tail");
  });

  test("the C1 forms, which terminals read exactly as their two-byte twins", () => {
    // Dropping `ESC` alone would leave these working, which is why the C1 range is named
    // in the criterion at all.
    expect(sanitize(`a${C1_CSI}2Jb`)).toBe("ab");
    expect(sanitize(`a${C1_OSC}0;pwned${BEL}b`)).toBe("ab");
  });

  test("C0 and DEL, because a newline in a title is a row that grew to two lines", () => {
    const hostile = `one${ctrl(0x0a)}two${ctrl(0x0d)}three${ctrl(0x09)}four${DEL}five`;

    expect(sanitize(hostile)).toBe("onetwothreefourfive");
  });

  test("a dropped C1 does not swallow the colour that follows it", () => {
    expect(sanitize(`${C1_CSI}2J${RED}kept${RESET}`)).toBe(`${RED}kept${RESET}`);
  });

  test("the other string families, payload and all", () => {
    // DCS, SOS, PM and APC each run to a terminator like an OSC does. Dropping only the
    // introducer would leave a Sixel image or a `DECRQSS` reply as visible text in a row.
    expect(sanitize(`a${ESC}Pq#0;2;0;0;0#1${ST}b`)).toBe("ab");
    expect(sanitize(`a${ESC}Xsos${ST}b`)).toBe("ab");
    expect(sanitize(`a${ESC}^pm${ST}b`)).toBe("ab");
    expect(sanitize(`a${ESC}_apc${ST}b`)).toBe("ab");
  });

  test("the bidirectional overrides, which reorder what a row says", () => {
    // CVE-2021-42574's shape. It lands on this component in particular because the payload
    // a row resolves to is deliberately not the text it displays, so a row made to read as
    // someone else's branch is a row that can be acted on.
    expect(sanitize(`fix/${ctrl(0x202e)}nwo-ym-toober${ctrl(0x202c)}`)).toBe("fix/nwo-ym-toober");
    expect(sanitize(`a${ctrl(0x2066)}b${ctrl(0x2069)}c`)).toBe("abc");
    expect(sanitize(`a${ctrl(0x200f)}b${ctrl(0x061c)}c`)).toBe("abc");
    // The line and paragraph separators, for the same reason the C0 newline goes.
    expect(sanitize(`a${ctrl(0x2028)}b${ctrl(0x2029)}c`)).toBe("abc");
  });

  test("but the zero-width joiner stays, because emoji are made of it", () => {
    // The one member of the zero-width family that reorders nothing and carries meaning:
    // strip it and a multi-person emoji becomes several separate people.
    expect(sanitize("👨‍👩‍👧")).toBe("👨‍👩‍👧");
  });
});

describe("the preview pane keeps hyperlinks, and only hyperlinks", () => {
  /** An OSC 8 opener, written the way a renderer emits one. */
  const link = (uri: string, params = ""): string => `${ESC}]8;${params};${uri}${BEL}`;

  /** The close sequence: OSC 8 with no URI. */
  const CLOSE = link("");

  test("a row's filter drops the hyperlink a document wants", () => {
    // The finding this pair of functions exists for. `sanitize` is unchanged, and what it
    // does to an OSC 8 is exactly what it does to every other OSC.
    expect(sanitize(`${link("https://example.com")}text${CLOSE}`)).toBe("text");
  });

  test("an https hyperlink survives, opener and close alike", () => {
    const linked = `${link("https://github.com/macintacos/wrk/pull/26")}#26${CLOSE}`;

    expect(sanitizePreview(linked)).toBe(linked);
  });

  test("so do http and mailto", () => {
    // `http://example.com` comes back as `http://example.com/` because the URI is re-emitted
    // from `URL`'s own normalisation rather than echoed — see the control-character case for
    // why. The trailing close is what an opener with nothing after it earns.
    expect(sanitizePreview(link("http://example.com"))).toBe(
      `${link("http://example.com/")}${CLOSE}`,
    );
    expect(sanitizePreview(link("mailto:someone@example.com"))).toBe(
      `${link("mailto:someone@example.com")}${CLOSE}`,
    );
  });

  test("a control character inside the URI does not ride in on a valid scheme", () => {
    // The hole an echoed URI leaves open, and the sharpest one in this module: an OSC payload
    // may hold any byte but ESC and BEL, and `URL` accepts an eight-bit CSI or a bidi override
    // inside an otherwise perfectly good https URI. Echoing it would put both through a filter
    // that had just approved the sequence carrying them.
    const hostile = sanitizePreview(link(`https://example.com/${C1_CSI}2J${ctrl(0x202e)}`));

    expect(hostile).not.toContain(C1_CSI);
    expect(hostile).not.toContain(ctrl(0x202e));
    expect(hostile).toBe(`${link("https://example.com/%C2%9B2J%E2%80%AE")}${CLOSE}`);
  });

  test("an id parameter rides along", () => {
    // The params field is what a renderer uses to join two runs into one link.
    const linked = link("https://example.com/", "id=1-42");

    expect(sanitizePreview(linked)).toBe(`${linked}${CLOSE}`);
  });

  test("the ST-terminated form survives, canonicalised to BEL", () => {
    // Kept as `ESC \` the opener would lose its terminator to the two-character-escape
    // branch on the next pass and leave the terminal waiting for one that never comes.
    expect(sanitizePreview(`${ESC}]8;;https://example.com${ST}x`)).toBe(
      `${link("https://example.com/")}x${CLOSE}`,
    );
  });

  test("a line that leaves a link open has it closed", () => {
    // A hyperlink is terminal state that outlives the string carrying it: unclosed, it takes
    // in every row drawn below the pane and the shell prompt after the picker erases itself.
    expect(sanitizePreview(`${link("https://example.com/")}click me`)).toBe(
      `${link("https://example.com/")}click me${CLOSE}`,
    );
    // A line that closes its own link is not closed twice.
    expect(sanitizePreview(`${link("https://example.com/")}ok${CLOSE}`)).toBe(
      `${link("https://example.com/")}ok${CLOSE}`,
    );
    // And a line whose only hyperlink was rejected leaves nothing open to close.
    expect(sanitizePreview(`${link("javascript:alert(1)")}x`)).toBe("x");
  });

  test("a scheme a terminal should never be handed is dropped whole", () => {
    expect(sanitizePreview(`${link("javascript:alert(1)")}click${CLOSE}`)).toBe(`click${CLOSE}`);
    expect(sanitizePreview(`${link("data:text/html,<script/>")}x${CLOSE}`)).toBe(`x${CLOSE}`);
    expect(sanitizePreview(`${link("file:///etc/passwd")}x${CLOSE}`)).toBe(`x${CLOSE}`);
  });

  test("so is a URI that is not one", () => {
    expect(sanitizePreview(`${link("not a url")}x`)).toBe("x");
    expect(sanitizePreview(`${link("://")}x`)).toBe("x");
  });

  test("and a params field carrying anything structural", () => {
    // `;` cannot appear because the pattern stops at it, so the case that matters is a
    // parameter smuggling bytes the token set does not admit.
    expect(sanitizePreview(`${ESC}]8;id=a b;https://example.com${BEL}x`)).toBe("x");
  });

  test("every other OSC is still dropped, so this is not 'OSC is allowed now'", () => {
    expect(sanitizePreview(`copy${ESC}]52;c;cHduZWQ=${BEL}here`)).toBe("copyhere");
    expect(sanitizePreview(`title${ESC}]0;pwned${BEL}here`)).toBe("titlehere");
    // Including OSC 8's own eight-bit form, which the allowlist is deliberately not written
    // in — a hyperlink worth keeping has never arrived that way.
    expect(sanitizePreview(`a${C1_OSC}8;;https://example.com${BEL}b`)).toBe("ab");
  });

  test("everything sanitize drops, this drops too", () => {
    expect(sanitizePreview(`before${ESC}[2Jafter`)).toBe("beforeafter");
    expect(sanitizePreview(`a${ESC}[10;1Hb${ESC}[5Ac`)).toBe("abc");
    expect(sanitizePreview(`a${C1_CSI}2Jb`)).toBe("ab");
    expect(sanitizePreview(`one${ctrl(0x0a)}two`)).toBe("onetwo");
    expect(sanitizePreview(`fix/${ctrl(0x202e)}nwo-ym-toober`)).toBe("fix/nwo-ym-toober");
  });

  test("and colour survives it exactly as it survives sanitize", () => {
    expect(sanitizePreview(`${RED}danger${RESET}`)).toBe(`${RED}danger${RESET}`);
  });
});

describe("stripSgr removes what sanitize keeps", () => {
  test("the colour goes and the text stays", () => {
    expect(stripSgr(`${RED}danger${RESET}`)).toBe("danger");
  });

  test("text with no colour is returned unchanged", () => {
    expect(stripSgr("plain")).toBe("plain");
  });
});
