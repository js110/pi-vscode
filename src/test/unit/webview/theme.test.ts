import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

const COLOR = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g;
// Shadow blurs and mask gradients are theme-neutral by convention (black at
// low alpha reads on both light and dark surfaces); a color inside a
// var(--vscode-…, fallback) only applies when the theme variable is missing.
// Anything else must come from --vscode-* variables so the four theme×language
// combos stay intact.
const DECLARATION_ALLOW = /box-shadow|-webkit-mask/;

/** Character spans of balanced var(...) expressions in a line. */
function varSpans(line: string): Array<[number, number]> {
    const spans: Array<[number, number]> = [];
    for (let i = line.indexOf('var('); i !== -1; i = line.indexOf('var(', i + 1)) {
        let depth = 1;
        for (let j = i + 4; j < line.length; j++) {
            if (line[j] === '(') depth++;
            else if (line[j] === ')') {
                depth--;
                if (depth === 0) {
                    spans.push([i, j]);
                    break;
                }
            }
        }
    }
    return spans;
}

describe('webview theme variables (AC-OP-02)', () => {
    const stylesDir = new URL('../../../webview/styles/', import.meta.url);
    const files = readdirSync(stylesDir).filter((f) => f.endsWith('.css'));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
        it(`${file} keeps colors on CSS variables outside shadows/masks`, () => {
            const css = readFileSync(new URL(file, stylesDir), 'utf-8');
            const offenders = css
                .split('\n')
                .flatMap((line, i) => {
                    if (DECLARATION_ALLOW.test(line)) return [];
                    const spans = varSpans(line);
                    const bare = [...line.matchAll(COLOR)].filter(
                        (m) => !spans.some(([a, b]) => (m.index ?? -1) >= a && (m.index ?? -1) <= b),
                    );
                    return bare.length > 0 ? [`L${i + 1}: ${line.trim()}`] : [];
                });
            expect(offenders).toEqual([]);
        });
    }
});
