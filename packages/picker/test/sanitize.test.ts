/**
 * The trust boundary, stated as the sequences that must not survive it.
 *
 * A picker row is a branch name or a pull-request title, and on a fork both are written by
 * whoever opened the pull request. Writing one to a terminal unfiltered hands that person
 * the terminal: an escape sequence can move the cursor, erase the screen, rename the
 * window, or — through OSC 52 — put text on the user's clipboard. fzf shipped this same
 * filter in 0.73.0, and the allowlist here is its allowlist: colour, and nothing else.
 *
 * Every case below names a sequence a real terminal acts on, so a regression here is a
 * regression in what an attacker can make the terminal do — not a formatting nit.
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
});

describe("stripSgr removes what sanitize keeps", () => {
  test("the colour goes and the text stays", () => {
    expect(stripSgr(`${RED}danger${RESET}`)).toBe("danger");
  });

  test("text with no colour is returned unchanged", () => {
    expect(stripSgr("plain")).toBe("plain");
  });
});
