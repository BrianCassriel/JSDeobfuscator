import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import { OUTPUT_FILE_KEY, SOURCE_FILE_KEY } from './consts';

hljs.registerLanguage('javascript', javascript);

export function highlightJavaScript(sourceCode: string): string {
    return hljs.highlight(sourceCode, { language: 'javascript' }).value;
};

export function setOutputFile(output: string) {
    sessionStorage.setItem(OUTPUT_FILE_KEY, output);
    const outputElement = document.getElementById(OUTPUT_FILE_KEY);
    if (outputElement)
        outputElement.textContent = output;
}

export function getOutputFile(): string | null {
    return sessionStorage.getItem(OUTPUT_FILE_KEY);
}

export function getSourceFile(): string | null {
    return sessionStorage.getItem(SOURCE_FILE_KEY);
}