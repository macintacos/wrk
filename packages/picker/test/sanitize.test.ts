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

import { sanitize, stripSgr } from "../src/sanitize";

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

describe("stripSgr removes what sanitize keeps", () => {
  test("the colour goes and the text stays", () => {
    expect(stripSgr(`${RED}danger${RESET}`)).toBe("danger");
  });

  test("text with no colour is returned unchanged", () => {
    expect(stripSgr("plain")).toBe("plain");
  });
});
