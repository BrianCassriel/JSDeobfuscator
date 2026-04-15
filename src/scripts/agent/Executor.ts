import { getOutputFile, setOutputFile } from "../../utils";
import { OutputFileTools } from "./tools/OutputFileTools";

export class Executor {
    static previousContent: string = "";

    static execute(patch: { startCharacter: number, characters: string, reason: string }) {
        const outputFile = getOutputFile() ?? "";
        this.previousContent = outputFile;
        OutputFileTools.writeCharacters(outputFile, patch.startCharacter, patch.characters);
    }

    static revert() {
        setOutputFile(this.previousContent);
    }
}