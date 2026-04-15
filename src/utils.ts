import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import { OUTPUT_FILE_KEY, SOURCE_FILE_KEY } from './consts';

hljs.registerLanguage('javascript', javascript);

export function highlightJavaScript(sourceCode: string): string {
    return hljs.highlight(sourceCode, { language: 'javascript' }).value;
}

export function setOutputFile(output: string) {
    const outputElement = document.getElementById(OUTPUT_FILE_KEY);
    if (outputElement)
        outputElement.innerHTML = highlightJavaScript(output);
}

export function getOutputFile(): string | null {
    return document.getElementById(OUTPUT_FILE_KEY)?.textContent ?? null;
}

export function getSourceFile(): string | null {
    return sessionStorage.getItem(SOURCE_FILE_KEY);
}