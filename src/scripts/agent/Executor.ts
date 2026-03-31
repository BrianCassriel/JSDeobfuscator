import { setOutputFile } from "../../utils";
import { OutputFileTools } from "./tools/OutputFileTools";

export class Executor {
    static previousContent: string = "";

    static execute(patch: { startLine: number, replacement: string, reason: string }, outputFile: string) {
        this.previousContent = outputFile;
        OutputFileTools.writeLines(outputFile, patch.startLine, patch.replacement);
    }

    static revert() {
        setOutputFile(this.previousContent);
    }
}