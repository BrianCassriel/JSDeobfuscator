import { setOutputFile } from "../../../utils";

export class OutputFileTools {
    static readLines(file: string, firstLine: number, lastLine: number): string {
        if (!file)
            throw new Error("File is empty.");
        const lines = file.split("\n");
        const selectedLines = lines.slice(firstLine - 1, lastLine);
        return selectedLines.join("\n");
    }

    static writeCharacters(file: string, startCharacter: number, characters: string): void {
        if (!file)
            throw new Error("File is empty.");
        const index = Math.max(0, Math.min(startCharacter - 1, file.length));
        const output = file.slice(0, index) + characters + file.slice(index + characters.length);
        setOutputFile(output);
        console.log(`Wrote characters at index ${startCharacter}: ${characters}`);
    }
}