export class OutputFileTools {
    static readLines(file: string, firstLine: number, lastLine: number): string {
        if (!file)
            throw new Error("File is empty.");
        const lines = file.split("\n");
        const selectedLines = lines.slice(firstLine - 1, lastLine);
        return selectedLines.join("\n");
    }

    static writeLines(file: string, startLine: number, lines: string): void {
        if (!file)
            throw new Error("File is empty.");
        const outputLines = file.split("\n");
        outputLines.splice(startLine - 1, lines.split("\n").length, ...lines.split("\n"));
        sessionStorage.setItem("outputFile", outputLines.join("\n"));
    }
}